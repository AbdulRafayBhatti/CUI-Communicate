import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';
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
export const safeUser = u => ({ _id: u._id, name: u.name, email: u.email, role: u.role, campus: u.campus, department: u.department, assignments: u.assignments, avatarColor: u.avatarColor, lastSeen: u.lastSeen });
