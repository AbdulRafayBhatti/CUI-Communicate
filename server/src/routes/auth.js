import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { RefreshToken, User } from '../models/index.js';
import { syncDefaultMemberships } from '../services/enrollment.js';
import { requireAuth, safeUser } from '../middleware/auth.js';
import { audit } from '../services/policy.js';
import {
  ENROLLMENT_MINUTES, LOGIN_LOCK_MINUTES, MAX_LOGIN_ATTEMPTS, MAX_MFA_ATTEMPTS, MFA_LOCK_MINUTES, MFA_TOKEN_SECONDS,
  decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, mfaRequiredFor,
  otpauthUri, recoveryCodeMatches, totpStep, verifyTotp
} from '../services/mfa.js';
import { clearRefreshCookie, endSession, presentedFamily, presentedRefreshToken, revokeFamilyById, rotateSession, setRefreshCookie, startSession } from '../services/tokens.js';
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

// --- second factor (TOTP) -------------------------------------------------------------------------------------
// With MFA enabled the password (or campus SSO) step only proves the first factor: instead of a session the API
// answers with a five-minute, single-purpose token, and /auth/mfa/verify issues the real session.
const mfaEnrollmentRequired = user => mfaRequiredFor(user.role) && !user.mfa?.enabled;
const secondFactorChallenge = (res, user) => res.json({
  mfaRequired: true,
  mfaToken: jwt.sign({ sub: String(user._id), sv: user.securityVersion, purpose: 'mfa' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: MFA_TOKEN_SECONDS }),
  expiresIn: MFA_TOKEN_SECONDS,
  methods: ['totp', 'recovery']
});
const mfaLocked = user => user.mfa?.lockedUntil && user.mfa.lockedUntil > new Date();

/**
 * Checks a code from the authenticator app or a recovery code. A TOTP step that was already used is refused, so an
 * observed code cannot be replayed; a recovery code is consumed on first use. The caller saves the user document.
 */
async function verifySecondFactor(user, code, useRecoveryCode = false) {
  if (useRecoveryCode) {
    for (const entry of user.mfa.recoveryCodes || []) {
      if (entry.usedAt || !(await recoveryCodeMatches(code, entry.hash))) continue;
      entry.usedAt = new Date();
      return { ok: true, method: 'recovery' };
    }
    return { ok: false, reason: 'That recovery code is not valid or has already been used.' };
  }
  const secret = decryptSecret(user.mfa.secret);
  const step = verifyTotp(secret, code, { afterStep: user.mfa.lastStep ?? -1 });
  if (step === -1) {
    // A code that is correct but was already accepted reads as a reuse, not as a typo: say so.
    const used = totpStep(secret, code);
    return { ok: false, reason: used !== -1 && used <= (user.mfa.lastStep ?? -1)
      ? 'That code was already used. Wait for your authenticator app to show the next one.'
      : 'That code is not valid. Check your authenticator app and try again.' };
  }
  user.mfa.lastStep = step;
  return { ok: true, method: 'totp' };
}

/** Per-account password backoff: consecutive failures lock the account for a while. */
async function recordLoginFailure(user) {
  const attempts = (user.failedLogins || 0) + 1;
  const locked = attempts >= MAX_LOGIN_ATTEMPTS;
  await User.updateOne({ _id: user._id }, {
    $set: { failedLogins: locked ? 0 : attempts, ...(locked ? { lockedUntil: new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000) } : {}) }
  });
  if (locked) await audit(user, 'auth.login.locked', 'User', user._id, 'account', { attempts }, 'denied');
}

/** Wrong codes are counted per account and lock the step briefly; the response never says which part failed. */
async function recordMfaFailure(user, req, reason) {
  const attempts = (user.mfa.attempts || 0) + 1;
  const locked = attempts >= MAX_MFA_ATTEMPTS;
  await User.updateOne({ _id: user._id }, {
    $set: {
      'mfa.attempts': locked ? 0 : attempts,
      ...(locked ? { 'mfa.lockedUntil': new Date(Date.now() + MFA_LOCK_MINUTES * 60000) } : {})
    }
  });
  await audit(user, locked ? 'auth.mfa.locked' : 'auth.mfa.failure', 'User', user._id, 'account', { reason }, 'denied');
  if (locked) console.warn(`Second-factor verification locked for ${user.email} after ${MAX_MFA_ATTEMPTS} failed attempts.`);
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
  if (user?.lockedUntil && user.lockedUntil > new Date()) return res.status(429).json({message:`Too many failed sign-in attempts. This account is locked for ${LOGIN_LOCK_MINUTES} minutes.`});
  if (!user || user.status!=='active' || !await bcrypt.compare(password||'',user.passwordHash)) {
    // Per-account backoff counts consecutive failures; the answer never reveals whether the address exists.
    if (user) await recordLoginFailure(user);
    return res.status(401).json({message:'Email or password is incorrect.'});
  }
  if (user.failedLogins) await User.updateOne({_id:user._id},{$set:{failedLogins:0}});
  await syncDefaultMemberships(user);
  // With a second factor enrolled this is only step one: the session is issued by /auth/mfa/verify.
  if (user.mfa?.enabled) return secondFactorChallenge(res,user);
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
    // Google and Facebook do not guarantee a second factor, so an account with MFA still gets the MFA step here.
    if(user.mfa?.enabled)return secondFactorChallenge(res,user);
    await respondWithSession(req,res,user);
  } catch(e) {
    console.error('SSO sign-in failed:',e.message);
    res.status(502).json({message:'The campus SSO provider could not be reached. Try again or sign in with your password.'});
  }
});
// Step two of sign-in. The five-minute token issued by /login or /auth/sso authorises exactly this call.
router.post('/mfa/verify', async (req,res) => {
  const useRecoveryCode = req.body?.recovery === true || String(req.body?.method||'') === 'recovery';
  let claims;
  try { claims = jwt.verify(String(req.body?.mfaToken||''), process.env.JWT_SECRET, { algorithms:['HS256'] }); }
  catch { return res.status(401).json({message:'This verification step expired. Sign in again.'}); }
  if (claims.purpose !== 'mfa') return res.status(401).json({message:'This verification step expired. Sign in again.'});
  const user = await User.findById(claims.sub).select('+mfa.secret +mfa.recoveryCodes');
  if (!user || user.status!=='active' || !user.mfa?.enabled || claims.sv !== user.securityVersion) return res.status(401).json({message:'Your sign-in is no longer valid. Start again.'});
  if (mfaLocked(user)) return res.status(429).json({message:`Too many incorrect codes. Try again in ${MFA_LOCK_MINUTES} minutes, or sign in again later.`});
  const result = await verifySecondFactor(user, req.body?.code, useRecoveryCode);
  if (!result.ok) { await recordMfaFailure(user, req, useRecoveryCode ? 'recovery' : 'totp'); return res.status(401).json({message:result.reason}); }
  user.mfa.attempts = 0;
  user.mfa.lockedUntil = undefined;
  await user.save();
  await audit(user, result.method === 'recovery' ? 'auth.mfa.recovery_used' : 'auth.mfa.success', 'User', user._id, 'account', { method: result.method });
  await syncDefaultMemberships(user);
  await respondWithSession(req,res,user);
});
// Enrolment, step 1: mint a secret for the authenticator app. It stays pending until a code confirms it.
router.post('/mfa/setup', requireAuth, async (req,res) => {
  if (req.user.mfa?.enabled) return res.status(409).json({message:'Two-factor authentication is already enabled on this account.'});
  const secret = generateTotpSecret();
  const otpauth = otpauthUri({ secret, label: req.user.email });
  await User.updateOne({_id:req.user._id},{$set:{'mfa.pendingSecret':encryptSecret(secret),'mfa.pendingCreatedAt':new Date()}});
  // The QR image is a convenience only: the secret is always returned as well, so manual entry always works.
  const qr = await QRCode.toDataURL(otpauth,{margin:1,width:220}).catch(()=>'');
  res.json({ secret, otpauth, qr, expiresIn: ENROLLMENT_MINUTES*60 });
});
// Enrolment, step 2: a valid code turns the pending secret into the account's second factor.
router.post('/mfa/enable', requireAuth, async (req,res) => {
  const user = await User.findById(req.user._id).select('+mfa.pendingSecret');
  if (!user) return res.status(401).json({message:'Sign in again to continue.'});
  if (user.mfa?.enabled) return res.status(409).json({message:'Two-factor authentication is already enabled on this account.'});
  const ageMinutes = user.mfa?.pendingCreatedAt ? (Date.now() - new Date(user.mfa.pendingCreatedAt).getTime())/60000 : Infinity;
  if (!user.mfa?.pendingSecret || ageMinutes > ENROLLMENT_MINUTES) return res.status(400).json({message:'This set-up expired. Start the set-up again for a new code.'});
  const step = verifyTotp(decryptSecret(user.mfa.pendingSecret), req.body?.code);
  if (step === -1) return res.status(401).json({message:'That code is not valid. Check your authenticator app and try again.'});
  const recoveryCodes = generateRecoveryCodes();
  user.mfa.enabled = true;
  user.mfa.secret = user.mfa.pendingSecret;
  user.mfa.pendingSecret = '';
  user.mfa.pendingCreatedAt = undefined;
  user.mfa.lastStep = step;
  user.mfa.enabledAt = new Date();
  user.mfa.attempts = 0;
  user.mfa.lockedUntil = undefined;
  user.mfa.recoveryCodes = await Promise.all(recoveryCodes.map(async code => ({ hash: await hashRecoveryCode(code), usedAt: null })));
  await user.save();
  await audit(req.user, 'auth.mfa.enabled', 'User', user._id, 'account');
  // Returned once: the account keeps only bcrypt hashes of these codes.
  res.json({ enabled:true, recoveryCodes });
});
// Turning the factor off is a security downgrade: it needs a valid code and it ends every session on every device.
router.post('/mfa/disable', requireAuth, async (req,res) => {
  const user = await User.findById(req.user._id).select('+mfa.secret +mfa.recoveryCodes');
  if (!user?.mfa?.enabled) return res.status(400).json({message:'Two-factor authentication is not enabled on this account.'});
  if (mfaRequiredFor(user.role)) return res.status(403).json({message:'Two-factor authentication is required for your role and cannot be turned off here. Ask a Technical Admin to reset it if you lost your device.'});
  if (mfaLocked(user)) return res.status(429).json({message:`Too many incorrect codes. Try again in ${MFA_LOCK_MINUTES} minutes.`});
  const result = await verifySecondFactor(user, req.body?.code, req.body?.recovery === true);
  if (!result.ok) { await recordMfaFailure(user, req, 'disable'); return res.status(401).json({message:result.reason}); }
  user.mfa = { enabled:false, secret:'', pendingSecret:'', recoveryCodes:[], lastStep:-1, attempts:0 };
  user.securityVersion += 1;
  await user.save();
  await audit(req.user, 'auth.mfa.disabled', 'User', user._id, 'account');
  await respondWithSession(req,res,user);
});
// Signed-in devices for the Security page: one entry per session family, newest first.
router.get('/sessions', requireAuth, async (req,res) => {
  const currentFamily = await presentedFamily(req);
  const records = await RefreshToken.find({ user: req.user._id }).sort({ createdAt: -1 });
  const sessions = [];
  const seen = new Set();
  for (const record of records) {
    if (record.revokedAt || seen.has(record.familyId)) continue;
    seen.add(record.familyId);
    sessions.push({
      id: record.familyId,
      userAgent: record.userAgent || 'Unknown device',
      startedAt: record.createdAt,
      lastUsedAt: record.usedAt || record.createdAt,
      current: record.familyId === currentFamily
    });
  }
  res.json(sessions);
});
// Sign one device out without touching the others.
router.delete('/sessions/:id', requireAuth, async (req,res) => {
  const familyId = String(req.params.id||'');
  if (!familyId || !await RefreshToken.exists({ user: req.user._id, familyId })) return res.status(404).json({message:'That session was not found on this account.'});
  const wasCurrent = familyId === await presentedFamily(req);
  await revokeFamilyById(familyId);
  if (wasCurrent) clearRefreshCookie(req,res);
  await audit(req.user, 'auth.session.revoked', 'User', req.user._id, 'account', { current: wasCurrent });
  res.json({ ok:true, current: wasCurrent, message: wasCurrent ? 'This device was signed out.' : 'That device was signed out.' });
});
export default router;
