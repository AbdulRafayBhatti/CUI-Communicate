import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';
import { mfaRequiredFor } from '../services/mfa.js';
export async function requireAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ message: 'Sign in to continue.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(payload.sub);
    if (!user || user.status !== 'active') return res.status(401).json({ message: 'Account is unavailable.' });
    if (!Number.isInteger(payload.sv) || payload.sv !== user.securityVersion) return res.status(401).json({ message: 'Your session was revoked. Sign in again.' });
    req.user = user; next();
  } catch { return res.status(401).json({ message: 'Your session is invalid or expired.' }); }
}
export const safeUser = u => {
  const mfaEnabled = !!u.mfa?.enabled;
  const mfaRequired = mfaRequiredFor(u.role);
  return {
    _id: u._id, name: u.name, email: u.email, role: u.role, campus: u.campus, department: u.department,
    assignments: u.assignments, avatarColor: u.avatarColor, lastSeen: u.lastSeen,
    mfaEnabled, mfaRequired, mfaEnrollmentRequired: mfaRequired && !mfaEnabled
  };
};

/**
 * Privileged roles must carry a second factor. Until they enrol, the messaging API stays closed; the auth routes
 * (including the MFA enrolment endpoints) keep working, so the account can always set it up.
 */
export function requireMfaEnrolled(req, res, next) {
  if (!mfaRequiredFor(req.user.role) || req.user.mfa?.enabled) return next();
  return res.status(403).json({
    code: 'MFA_ENROLLMENT_REQUIRED',
    message: 'Two-factor authentication is required for your role. Set it up under Security to continue.'
  });
}
