'use strict';
/**
 * totp.js — RFC 6238 (TOTP) / RFC 4226 (HOTP) / RFC 4648 (base32) — no
 * external dependencies, built on Node's built-in `crypto`.
 *
 * Used by server/application/twoFactor.js to gate switching a user into
 * live trading mode (Fase 3 pendiente #1) behind a standard authenticator
 * app (Google Authenticator, Authy, 1Password, etc.) rather than a
 * custom/weaker scheme.
 *
 * Step = 30s, digits = 6, algorithm = SHA-1 (the universal default every
 * authenticator app assumes when no `algorithm=` param is present in the
 * otpauth:// URI).
 */

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits, RFC 4226 recommended HOTP key length

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ─── RFC 4648 base32 ───────────────────────────────────────────────────────

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const cleaned = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  if (cleaned.length === 0) return Buffer.alloc(0);
  if (!/^[A-Z2-7]+$/.test(cleaned)) {
    throw new Error('Invalid base32 string');
  }

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ─── Secret generation ──────────────────────────────────────────────────

function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

// ─── HOTP (RFC 4226) ────────────────────────────────────────────────────

function _hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer; Number is safe well past any
  // realistic TOTP counter value (2^53 steps * 30s is billions of years).
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const token = (binCode % 10 ** DIGITS).toString().padStart(DIGITS, '0');
  return token;
}

function _counterForTime(forTime) {
  const seconds = Math.floor((forTime ?? Date.now()) / 1000);
  return Math.floor(seconds / STEP_SECONDS);
}

// ─── TOTP (RFC 6238) ────────────────────────────────────────────────────

function generateToken(secretB32, { forTime } = {}) {
  const counter = _counterForTime(forTime);
  return _hotp(secretB32, counter);
}

/**
 * verifyToken — never throws, even on garbage input. `window` is the
 * number of steps of clock drift tolerated on either side (default 1 =
 * ±30s), matching what every mainstream authenticator client assumes.
 */
function verifyToken(secretB32, token, { forTime, window = 1 } = {}) {
  if (typeof token !== 'string' && typeof token !== 'number') return false;
  const normalized = String(token).trim();
  if (!/^\d{6}$/.test(normalized)) return false;

  try {
    const counter = _counterForTime(forTime);
    for (let delta = -window; delta <= window; delta++) {
      if (_hotp(secretB32, counter + delta) === normalized) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── otpauth:// URI (for QR-code enrollment) ───────────────────────────

function generateOtpauthUrl(secretB32, { issuer = 'Kukora', accountName = 'user' } = {}) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  generateToken,
  verifyToken,
  generateOtpauthUrl,
  STEP_SECONDS,
  DIGITS,
};
