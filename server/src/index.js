import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import { User, Conversation, AuditLog } from './models/index.js';
import { canDirectWithoutRequest, relationshipSnapshot, relationshipSnapshotMatches, audit } from './services/policy.js';
import { setRealtimeServer } from './services/realtime.js';
import { recoverPendingBroadcasts } from './services/broadcast.js';
import ssoRouter, { initSso } from './sso/index.js';
import { pathToFileURL } from 'url';

const app=express(); const server=http.createServer(app);
// credentials: the browser must send and store the httpOnly refresh cookie on the auth endpoints.
app.use(cors({origin:process.env.CLIENT_URL||'http://localhost:5173',credentials:true})); app.use(express.json({limit:'1mb'}));
// Audit denied requests without recording credentials, message bodies, or other private content.
app.use((req,res,next)=>{res.on('finish',()=>{if(res.statusCode===401||res.statusCode===403){AuditLog.create({actor:req.user?._id,action:res.statusCode===401?'authentication.denied':'authorization.denied',resourceType:'HTTP',resourceId:String(req.path||'').slice(0,180),scope:'api',outcome:'denied',metadata:{method:req.method,statusCode:res.statusCode}}).catch(()=>{});}});next();});
// Credential endpoints (register/login/SSO) stay tightly limited. Silent rotation is excluded from that limit and
// gets its own lenient one instead: the SPA refreshes on every page load, and the preview proxy hides client IPs, so
// a strict per-IP credential limit would lock people out of their own session.
const authLimiter=rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false,skip:req=>['/refresh','/logout'].includes(String(req.path||''))});
const sessionLimiter=rateLimit({windowMs:15*60*1000,max:900,standardHeaders:true,legacyHeaders:false});
app.use('/api/auth/refresh',sessionLimiter); app.use('/api/auth/logout',sessionLimiter);
app.use('/api/auth',authLimiter,authRoutes); app.get('/api/health',(_,res)=>res.json({status:'ok',service:'CUI_Communicate'}));
// Multi-tenant single sign-on provider (OAuth 2.0 / OpenID Connect + tenant administration dashboard).
app.use(ssoRouter);
app.use('/api',apiRoutes);
app.use((err,req,res,next)=>{ if(res.headersSent) return next(err); if(!(err.status&&err.status<500))console.error('Request failed:',err.message); res.status(err.status || 500).json({message:err.status && err.status < 500 ? err.message : 'The request could not be completed.'}); });
const io=new Server(server,{cors:{origin:process.env.CLIENT_URL||'http://localhost:5173',methods:['GET','POST']}});
setRealtimeServer(io);
const socketMessageWindows = new Map();
function allowSocketMessage(userId, limit = 30, windowMs = 60_000) { const now = Date.now(); const recent = (socketMessageWindows.get(String(userId)) || []).filter(t => now - t < windowMs); if (recent.length >= limit) { socketMessageWindows.set(String(userId), recent); return false; } recent.push(now); socketMessageWindows.set(String(userId), recent); return true; }
io.use(async(socket,next)=>{try{const token=socket.handshake.auth?.token;if(!token)throw new Error('Sign in required');const p=jwt.verify(token,process.env.JWT_SECRET,{algorithms:['HS256']});const user=await User.findById(p.sub);if(!user||user.status!=='active')throw new Error('Account unavailable');if(!Number.isInteger(p.sv)||p.sv!==user.securityVersion)throw new Error('Session revoked. Sign in again.');socket.user=user;next();}catch(e){next(new Error(e.message||'Unauthorized'));}});
io.on('connection',async socket=>{
  socket.data.userId = String(socket.user._id); socket.data.authVersion = socket.user.securityVersion;
  const userRoom = `user:${socket.data.userId}`;
  const existingUserSockets = await io.in(userRoom).fetchSockets();
  socket.join(userRoom);
  const onlineUsers = [...new Set([...io.sockets.sockets.values()].filter(s=>s.data?.userId&&s.data?.authVersion===s.user?.securityVersion).map(s=>s.data.userId))];
  socket.emit('presence:snapshot',onlineUsers);
  if(existingUserSockets.length===0) socket.broadcast.emit('presence:changed',{userId:socket.data.userId,status:'online'});
  const freshUser = async () => { const user = await User.findById(socket.user._id); return user && user.status === 'active' && user.securityVersion === socket.data.authVersion ? user : null; };
  socket.on('conversation:join',async({conversationId}={},ack=()=>{})=>{try{const user=await freshUser();if(!user)return ack({error:'Account unavailable. Sign in again.'});const c=await Conversation.findById(conversationId);if(!c||!c.participants.some(p=>p.equals(user._id)))return ack({error:'Conversation access denied.'});if(c.blockedBy.length)return ack({error:'This conversation is restricted.'});if(c.requestState==='pending'&&!c.requestSender.equals(user._id))return ack({error:'Accept the request before opening this conversation.'});if(c.requestState==='declined')return ack({error:'This message request was declined.'});socket.join(`conversation:${c.id}`);ack({ok:true});}catch{ack({error:'Unable to join conversation.'});}});
  socket.on('message:send',async({conversationId,body}={},ack=()=>{})=>{try{
    const user=await freshUser();if(!user)return ack({error:'Account unavailable. Sign in again.'});
    const text=String(body||'').trim();if(!text||text.length>5000)return ack({error:'Message must be 1–5000 characters.'});if(!allowSocketMessage(user._id))return ack({error:'You are sending messages too quickly. Please wait a minute.'});
    const c=await Conversation.findById(conversationId);if(!c||!c.participants.some(p=>p.equals(user._id)))return ack({error:'Conversation access denied.'});
    if(c.blockedBy.length)return ack({error:'This conversation is restricted.'});
    if(c.requestState==='pending')return ack({error:'Only the initial message is allowed while a request is pending.'});
    if(c.requestState==='declined')return ack({error:'This request was declined.'});
    if(c.requestState!=='accepted')return ack({error:'This conversation is not accepted.'});
    const otherId=c.participants.find(p=>!p.equals(user._id));const other=await User.findById(otherId);
    const changed=other?!(await relationshipSnapshotMatches(c.relationshipSnapshot,user,other)):true;
    if(changed&&other&&!await canDirectWithoutRequest(user,other))return ack({error:'Your role or organizational relationship changed. Send a new message request to continue.'});
    if(changed&&other&&await canDirectWithoutRequest(user,other))c.relationshipSnapshot=await relationshipSnapshot(user,other);
    const msg={sender:user._id,body:text,createdAt:new Date()};c.messages.push(msg);c.lastMessageAt=new Date();await c.save();
    const savedMessage=c.messages[c.messages.length-1];
    const payload={conversationId:c.id,message:{_id:String(savedMessage._id),sender:{_id:user.id,name:user.name,role:user.role},body:savedMessage.body,createdAt:savedMessage.createdAt}};
    for(const participantId of c.participants){const target=await User.findById(participantId);if(!target||target.status!=='active')continue;const sockets=await io.in(`user:${participantId}`).fetchSockets();for(const recipientSocket of sockets)if(recipientSocket.data.authVersion===target.securityVersion){recipientSocket.emit('message:new',payload);if(!participantId.equals(user._id))recipientSocket.emit('notification:new',{type:'message',conversationId:c.id,from:user.name,preview:'New message'});}}
    ack({ok:true});
  }catch{ack({error:'Message could not be sent.'});}});
  // Groups are audiences, not rooms: there is deliberately no group:join / group:message. Broadcasts reach people through
  // their personal `user:<id>` room only (see services/broadcast.js).
  socket.on('typing:set',async({conversationId,typing}={})=>{try{const user=await freshUser();const c=await Conversation.findById(conversationId);if(!user||!c||c.requestState!=='accepted'||c.blockedBy.length||!c.participants.some(p=>p.equals(user._id)))return;const otherId=c.participants.find(p=>!p.equals(user._id));const other=await User.findById(otherId);if(!other||other.status!=='active')return;const changed=!(await relationshipSnapshotMatches(c.relationshipSnapshot,user,other));if(changed&&!await canDirectWithoutRequest(user,other))return;if(changed){c.relationshipSnapshot=await relationshipSnapshot(user,other);await c.save();}socket.to(`conversation:${c.id}`).emit('typing:changed',{conversationId,userId:user.id,name:user.name,typing:!!typing});}catch{ /* Typing signals fail closed and never expose conversation content. */ }});
  socket.on('disconnect',async()=>{
    try{
      const remaining=await io.in(userRoom).fetchSockets();
      if(remaining.length===0){
        await User.updateOne({_id:socket.user._id},{$set:{lastSeen:new Date()}});
        socket.broadcast.emit('presence:changed',{userId:socket.data.userId,status:'offline'});
      }
    }catch{ /* presence is best-effort; a failed lastSeen write must never become an unhandled rejection */ }
  });
});
export { app, server, io };
export async function startServer({ port = process.env.PORT || 5000, mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cui_communicate' } = {}) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters. Copy .env.example to .env and replace the example value.');
  await mongoose.connect(mongoUri);
  // Load/generate the RS256 key the SSO provider signs id and access tokens with.
  await initSso();
  // Complete any broadcast interrupted between saving the message and writing its deliveries (idempotent).
  await recoverPendingBroadcasts().then(n => { if (n) console.log(`Recovered ${n} interrupted broadcast(s).`); }).catch(e => console.error('Broadcast recovery failed:', e.message));
  await new Promise(resolve => server.listen(port, resolve));
  return server.address().port;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(p => console.log(`CUI_Communicate API listening on http://localhost:${p}`)).catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
}
