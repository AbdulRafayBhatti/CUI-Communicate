import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';
import { syncDefaultMemberships } from '../services/enrollment.js';
import { requireAuth, safeUser } from '../middleware/auth.js';
const router = Router();
const wrapAsync = handler => handler.constructor?.name === 'AsyncFunction' ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) : handler;
for (const method of ['get', 'post', 'patch', 'delete']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map(wrapAsync));
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
    const token = jwt.sign({sub:String(user._id),sv:user.securityVersion},process.env.JWT_SECRET,{expiresIn:'12h',algorithm:'HS256'});
    res.status(201).json({token,user:safeUser(user)});
  } catch(e) { res.status(500).json({message:'Could not create account.'}); }
});
router.post('/login', async (req,res) => {
  const {email,password}=req.body;
  const user=await User.findOne({email:String(email||'').trim().toLowerCase()}).select('+passwordHash');
  if (!user || user.status!=='active' || !await bcrypt.compare(password||'',user.passwordHash)) return res.status(401).json({message:'Email or password is incorrect.'});
  await syncDefaultMemberships(user);
  const token=jwt.sign({sub:String(user._id),sv:user.securityVersion},process.env.JWT_SECRET,{expiresIn:'12h',algorithm:'HS256'});
  res.json({token,user:safeUser(user)});
});
router.get('/me',requireAuth,(req,res)=>res.json({user:safeUser(req.user)}));
export default router;
