// Two-factor authentication (TOTP, RFC 6238) for messaging accounts.
//
// The workspace keeps its own second factor; the multi-tenant SSO provider (server/src/sso/) has a separate one and
// owns only the `sso_*` collections. A TOTP secret is stored encrypted with AES-256-GCM — the key comes from
// MFA_ENCRYPTION_KEY when it is set, otherwise it is derived from JWT_SECRET — so the database on its own never
// yields a usable shared secret. Recovery codes are stored only as bcrypt hashes and each code works exactly once.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const TOTP_STEP_SECONDS = 30;
export const MFA_TOKEN_SECONDS = 5 * 60;   // the half-signed-in state: password accepted, second factor still pending
export const ENROLLMENT_MINUTES = 15;      // how long a set-up secret stays usable before it must be restarted
export const RECOVERY_CODE_COUNT = 10;
export const MAX_MFA_ATTEMPTS = 5;         // wrong codes before the second-factor step locks
export const MFA_LOCK_MINUTES = 15;
export const MAX_LOGIN_ATTEMPTS = 8;       // wrong passwords before the account locks
export const LOGIN_LOCK_MINUTES = 15;

// Privileged roles must carry a second factor. Recovering one of these accounts stays the Technical Admin's job.
export const MFA_REQUIRED_ROLES = ['Technical Admin', 'Rector', 'Campus Incharge', 'HOD', 'Department Coordinator'];
export const mfaRequiredFor = role => MFA_REQUIRED_ROLES.includes(String(role || ''));

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const timingSafe = (a, b) => {
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
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    const index = ALPHABET.indexOf(char);
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

const hotp = (secretBuffer, counter, digits = 6) => {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', secretBuffer).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
};

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));
export const totpCode = (secret, at = Date.now()) => hotp(base32Decode(secret), Math.floor(at / 1000 / TOTP_STEP_SECONDS));

/**
 * Verifies a 6-digit code, tolerating one step of clock drift in each direction.
 * Returns the accepted time step, or -1. `afterStep` is the last step this account already used, so an observed code
 * cannot be replayed; the newest matching step wins.
 */
export function verifyTotp(secret, code, { afterStep = -1, at = Date.now(), window = 1 } = {}) {
  const candidate = String(code || '').replace(/\D/g, '');
  const key = base32Decode(secret);
  if (candidate.length !== 6 || !key.length) return -1;
  const step = Math.floor(at / 1000 / TOTP_STEP_SECONDS);
  for (let offset = window; offset >= -window; offset -= 1) {
    const candidateStep = step + offset;
    if (candidateStep <= afterStep) continue;
    if (timingSafe(candidate, hotp(key, candidateStep))) return candidateStep;
  }
  return -1;
}

/** The step a code belongs to, with no replay check. Used only to explain a refused reuse in plain language. */
export function totpStep(secret, code, at = Date.now(), window = 1) {
  const candidate = String(code || '').replace(/\D/g, '');
  const key = base32Decode(secret);
  if (candidate.length !== 6 || !key.length) return -1;
  const step = Math.floor(at / 1000 / TOTP_STEP_SECONDS);
  for (let offset = window; offset >= -window; offset -= 1) {
    if (timingSafe(candidate, hotp(key, step + offset))) return step + offset;
  }
  return -1;
}

export const otpauthUri = ({ secret, label, issuer = 'CUI_Communicate' }) =>  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;

/** One-time recovery codes, shown once at enrolment. Formatted as two base32 groups, e.g. ABCDE-FGHIJ. */
export const generateRecoveryCodes = (count = RECOVERY_CODE_COUNT) => Array.from({ length: count }, () =>
  `${base32Encode(crypto.randomBytes(5)).slice(0, 5)}-${base32Encode(crypto.randomBytes(4)).slice(0, 5)}`);

const normalizeRecoveryCode = value => String(value || '').trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
export const hashRecoveryCode = value => bcrypt.hash(normalizeRecoveryCode(value), 10);
export const recoveryCodeMatches = (value, hash) => bcrypt.compare(normalizeRecoveryCode(value), String(hash || ''));

const encryptionKey = () => crypto.createHash('sha256')
  .update(String(process.env.MFA_ENCRYPTION_KEY || `${process.env.JWT_SECRET || ''}|mfa-secret-encryption`))
  .digest();

/** AES-256-GCM. The stored value is `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** Returns '' when the value cannot be decrypted (wrong key, tampered data), which reads as "no usable secret". */
export function decryptSecret(blob) {
  try {
    const [version, iv, tag, data] = String(blob || '').split('.');
    if (version !== 'v1' || !iv || !tag || !data) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}
