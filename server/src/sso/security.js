// Cryptographic primitives for the SSO platform: password hashing/strength, TOTP (RFC 6238), recovery codes,
// PKCE verification, the RS256 signing key used for id/access tokens, and the audit trail helper.
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { SsoAuditEvent, SsoSigningKey } from './models.js';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBuffer, counter, digits = 6) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', secretBuffer).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));
export const totpCode = (secret, at = Date.now()) => hotp(base32Decode(secret), Math.floor(at / 1000 / TOTP_STEP_SECONDS));

/** Verifies a 6-digit TOTP, tolerating one step of clock drift in each direction. */
export function verifyTotp(secret, code, at = Date.now(), window = 1) {
  const candidate = String(code || '').replace(/\D/g, '');
  const key = base32Decode(secret);
  if (candidate.length !== 6 || !key.length) return false;
  const step = Math.floor(at / 1000 / TOTP_STEP_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    if (safeEqual(hotp(key, step + offset), candidate)) return true;
  }
  return false;
}

export const otpauthUri = ({ secret, label, issuer }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;

export const generateRecoveryCodes = (count = 10) => Array.from({ length: count }, () =>
  `${base32Encode(crypto.randomBytes(5)).slice(0, 5)}-${base32Encode(crypto.randomBytes(5)).slice(0, 5)}`);

export const hashSecret = (value, rounds = 10) => bcrypt.hash(String(value), rounds);
export const verifySecret = (value, hash) => bcrypt.compare(String(value || ''), String(hash || ''));

const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '123456789', 'qwerty123', 'letmein123', 'welcome123', 'admin123', 'iloveyou']);
/** Returns a human-readable problem, or null when the password satisfies the tenant policy. */
export function passwordProblems(password, minLength = 10) {
  const value = String(password || '');
  if (value.length < minLength) return `Password must be at least ${minLength} characters.`;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(value)).length;
  if (classes < 3) return 'Password must mix at least three of: lowercase, uppercase, digits, symbols.';
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return 'That password is too common. Choose something unique.';
  return null;
}

/** PKCE (RFC 7636): S256 is required for public clients; confidential clients may omit the challenge. */
export function verifyPkce(verifier, challenge, method = 'S256') {
  if (!challenge) return true;
  if (!verifier) return false;
  if (method === 'plain') return safeEqual(verifier, challenge);
  return safeEqual(crypto.createHash('sha256').update(String(verifier)).digest('base64url'), challenge);
}

const keyFromDoc = doc => ({ kid: doc.kid, algorithm: doc.algorithm, privatePem: doc.privatePem, publicPem: doc.publicPem });

/** Loads the active RS256 keypair, generating one on first boot so id/access tokens are verifiable via JWKS. */
export async function ensureSigningKey() {
  const existing = await SsoSigningKey.findOne({ active: true }).sort({ createdAt: -1 });
  if (existing) return keyFromDoc(existing);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(8).toString('hex');
  const doc = await SsoSigningKey.create({
    kid,
    algorithm: 'RS256',
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' })
  });
  return keyFromDoc(doc);
}

export const jwkFromPublicPem = (publicPem, kid) => ({
  ...crypto.createPublicKey(publicPem).export({ format: 'jwk' }),
  kid,
  use: 'sig',
  alg: 'RS256'
});

/** Security audit trail. Never allowed to break an authentication flow. */
export async function audit({ tenantId = null, type, outcome = 'success', actorId = null, actorEmail = '', req = null, detail = '' }) {
  try {
    await SsoAuditEvent.create({
      tenantId,
      type,
      outcome,
      actorId,
      actorEmail,
      ip: req?.ip || String(req?.socket?.remoteAddress || ''),
      userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
      detail: String(detail || '').slice(0, 300)
    });
  } catch { /* auditing is best-effort */ }
}
