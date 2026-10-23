import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';
import { syncDefaultMemberships } from '../services/enrollment.js';
import { requireAuth, safeUser } from '../middleware/auth.js';
import { clearRefreshCookie, endSession, presentedRefreshToken, rotateSession, setRefreshCookie, startSession } from '../services/tokens.js';
const router = Router();
const wrapAsync = handler => handler.constructor?.name === 'AsyncFunction' ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) : handler;
for (const method of ['get', 'post', 'patch', 'delete']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map(wrapAsync));
}
// Every sign-in path (password, registration, campus SSO) issues the same session: a short-lived access token in the
// response body and the rotating refresh token in an httpOnly cookie the browser never exposes to JavaScript.
async function respondWithSession(req, res, user, status = 200) {
  const session = await startSession(user, req);
  setRefreshCookie(req, res, session.refreshToken);
  res.status(status).json({ token: session.token, expiresIn: session.expiresIn, user: safeUser(user) });
}
router.post('/register', async (req,res) => {
  try {
    const { name,email,password,role,campus,department } = req.body;
    if (!String(name || '').trim() || !/^\S+@comsats\.edu\.pk$/i.test(String(email || '').trim()) || !password || String(password).length < 8) return res.status(400).json({message:'Use a name, a @comsats.edu.pk email, and a password of at least 8 characters.'});
    if (role && role !== 'Student') return res.status(403).json({message:'Self-registration is limited to Student accounts. Ask an authorized official to assign other roles.'});
    const cleanEmail = String(email).trim().toLowerCase();
    if (await User.exists({email:cleanEmail})) return res.status(409).json({message:'An account with this email already exists.'});
    // Self-registration creates an unassigned student account. Organizational scope must be assigned by an authorized official.
    const user = await User.create({name:String(name).trim(),email:cleanEmail,passwordHash:await bcrypt.hash(password,12),role:'Student',campus:'',department:'',assignments:[]});
    await syncDefaultMemberships(user);
    await respondWithSession(req,res,user,201);
  } catch(e) { res.status(500).json({message:'Could not create account.'}); }
});
router.post('/login', async (req,res) => {
  const {email,password}=req.body;
  const user=await User.findOne({email:String(email||'').trim().toLowerCase()}).select('+passwordHash');
  if (!user || user.status!=='active' || !await bcrypt.compare(password||'',user.passwordHash)) return res.status(401).json({message:'Email or password is incorrect.'});
  await syncDefaultMemberships(user);
  await respondWithSession(req,res,user);
});
router.get('/me',requireAuth,(req,res)=>res.json({user:safeUser(req.user)}));
// Silent rotation: the SPA calls this on load and after a 401, so the short-lived access token is renewed without
// the user signing in again. The refresh token itself travels only in the httpOnly cookie set below.
router.post('/refresh', async (req,res) => {
  const result = await rotateSession(presentedRefreshToken(req), req);
  if (result.error) {
    clearRefreshCookie(req,res);
    if (result.error === 'reuse') console.warn('Refresh token reuse detected; session family revoked.');
    return res.status(401).json({message:result.error==='reuse'?'This session was already replaced, so it was revoked for your safety. Sign in again.':result.error==='account'?'Your account is unavailable. Contact an authorized university official.':'Your session has expired. Sign in again.'});
  }
  setRefreshCookie(req,res,result.refreshToken);
  res.json({token:result.token,expiresIn:result.expiresIn,user:safeUser(result.user)});
});
// Real server-side sign-out: the presented refresh family is revoked, so the cookie is worthless afterwards.
router.post('/logout', async (req,res) => {
  await endSession(presentedRefreshToken(req));
  clearRefreshCookie(req,res);
  res.json({ok:true});
});
// Sign in through the campus SSO provider (the Google/Facebook buttons on the login screen).
// The workspace is an OpenID Connect client: the browser brings back an authorization code, this route exchanges it
// with the client secret, verifies the RS256 id_token against the provider's JWKS and issues the usual workspace
// session. The SSO platform keeps ownership of its own collections — nothing here reads the `sso_*` models.
const ssoIssuer=()=>String(process.env.SSO_ISSUER||'').replace(/\/+$/,'');
const ssoClientId=()=>process.env.SSO_CLIENT_ID||'cui-communicate';
const ssoRedirectUri=()=>`${String(process.env.MESSAGING_URL||process.env.CLIENT_URL||'http://localhost:5173').replace(/\/+$/,'')}/sso/callback`;
async function verifyIdToken(idToken){
  const [header,payload,signature]=String(idToken||'').split('.');
  if(!header||!payload||!signature)return {error:'The campus SSO provider did not return a valid identity token.'};
  let decoded,claims;
  try{decoded=JSON.parse(Buffer.from(header,'base64url').toString('utf8'));claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{return {error:'The campus SSO provider returned an unreadable identity token.'};}
  const jwks=await (await fetch(`${ssoIssuer()}/jwks`,{signal:AbortSignal.timeout(10000)})).json();
  const jwk=(jwks.keys||[]).find(key=>key.kid===decoded.kid);
  if(!jwk)return {error:'No matching signing key was found at the campus SSO provider.'};
  let signatureOk=false;
  try{signatureOk=crypto.verify('sha256',Buffer.from(`${header}.${payload}`),crypto.createPublicKey({key:jwk,format:'jwk'}),Buffer.from(signature,'base64url'));}catch{signatureOk=false;}
  if(!signatureOk)return {error:'The identity token signature is invalid.'};
  if(claims.iss!==ssoIssuer())return {error:'The identity token was issued by an unexpected provider.'};
  if(claims.aud!==ssoClientId())return {error:'The identity token was issued for a different application.'};
  if(!claims.exp||claims.exp*1000<Date.now())return {error:'The sign-in response has expired. Try again.'};
  return {claims};
}
router.post('/sso', async (req,res) => {
  const code=String(req.body?.code||''), codeVerifier=String(req.body?.code_verifier||'');
  if(!code)return res.status(400).json({message:'The sign-in response did not include an authorization code.'});
  if(!ssoIssuer())return res.status(503).json({message:'The campus SSO provider is not configured on this server.'});
  try {
    const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:ssoRedirectUri(),client_id:ssoClientId(),client_secret:process.env.MESSAGING_CLIENT_SECRET||''});
    if(codeVerifier)body.set('code_verifier',codeVerifier);
    const tokenResponse=await fetch(`${ssoIssuer()}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(10000)});
    const tokens=await tokenResponse.json().catch(()=>({}));
    if(!tokenResponse.ok||!tokens.id_token)return res.status(401).json({message:tokens.error_description||tokens.error||'The campus SSO provider rejected the sign-in.'});
    const verified=await verifyIdToken(tokens.id_token);
    if(verified.error)return res.status(401).json({message:verified.error});
    const claims=verified.claims, email=String(claims.email||'').trim().toLowerCase();
    if(!email)return res.status(401).json({message:'The campus SSO provider did not return an email address for this account.'});
    let user=await User.findOne({email});
    if(!user){
      // First sign-in for this campus identity: provision the same unassigned Student account self-registration creates.
      // Organizational scope is still assigned by an authorized official.
      user=await User.create({name:String(claims.name||email).trim().slice(0,120),email,passwordHash:await bcrypt.hash(crypto.randomBytes(24).toString('hex'),12),role:'Student',campus:'',department:'',assignments:[]});
    }
    if(user.status!=='active')return res.status(403).json({message:'This account is not active. Contact an authorized university official.'});
    await syncDefaultMemberships(user);
    await respondWithSession(req,res,user);
  } catch(e) {
    console.error('SSO sign-in failed:',e.message);
    res.status(502).json({message:'The campus SSO provider could not be reached. Try again or sign in with your password.'});
  }
});
export default router;
