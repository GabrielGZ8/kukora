'use strict';
/**
 * auth.js — JWT authentication for Kukora
 * Access token (15m) via Authorization: Bearer header
 * Refresh token (7d) in httpOnly cookie
 * Token rotation on refresh, blacklist on logout
 */

const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const express   = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('./logger');
const { User, TokenBlacklist } = require('../models');
const { verifyFirebaseIdToken } = require('./firebaseAdmin');

const router = express.Router();

// ─── JWT Secrets (Issue 6 fix) ────────────────────────────────────────────
// In production, both secrets MUST be set — process exits if they're missing.
// In development, randomly generated secrets are used (sessions won't survive restart).
const _JWT_SECRET_ENV         = process.env.JWT_SECRET;
const _JWT_REFRESH_SECRET_ENV = process.env.JWT_REFRESH_SECRET;

if (!_JWT_SECRET_ENV || !_JWT_REFRESH_SECRET_ENV) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('auth', 'FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be set in production');
    process.exit(1);
  }
  logger.warn('auth', 'JWT secrets not set — using random secrets. Sessions will not persist across restarts.');
}

const JWT_SECRET         = _JWT_SECRET_ENV         || crypto.randomBytes(64).toString('hex');

// H-7 fix (Sesión 20): sin esto, `role: 'admin'` en el User model era
// inalcanzable — no existía NINGÚN camino (seed script, flag de registro,
// endpoint) para que un usuario real terminara con ese rol, así que
// gatear endpoints detrás de requireRole('admin') sin esto habría
// bloqueado el demo en vivo para TODOS, incluyendo al dueño del proyecto.
// ADMIN_EMAILS (coma-separado, case-insensitive) es la fuente de verdad:
// se revisa en cada registro/login y "autosana" el rol si no coincide,
// sin necesidad de migraciones de DB ni tocar Mongo a mano.
function _resolveRole(email) {
  const normalized = (email || '').toLowerCase();
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (adminEmails.includes(normalized)) return 'admin';

  // Same self-healing pattern as ADMIN_EMAILS, one tier down: OPERATOR_EMAILS
  // grants the 'operator' role (day-to-day ops actions — see rbac.js) without
  // the most sensitive admin-only permissions (kill switches, user mgmt).
  const operatorEmails = (process.env.OPERATOR_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (operatorEmails.includes(normalized)) return 'operator';

  return 'user';
}

// Ensures user.role matches ADMIN_EMAILS right now — call after every
// successful auth (register/login/oauth) so promotions/demotions take
// effect on next login without any manual DB step.
async function _syncRole(user) {
  const desired = _resolveRole(user.email);
  if (user.role !== desired) {
    user.role = desired;
    await User.findByIdAndUpdate(user._id, { role: desired });
  }
  return user;
}
const JWT_REFRESH_SECRET = _JWT_REFRESH_SECRET_ENV || crypto.randomBytes(64).toString('hex');
const ACCESS_TTL         = '15m';
const REFRESH_TTL        = '7d';
const REFRESH_TTL_MS     = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS      = 12;
const IS_PROD            = process.env.NODE_ENV === 'production';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many auth attempts. Try again in 15 minutes.' },
});

function generateAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, name: user.name, role: user.role, onboardingDone: !!user.onboardingDone },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL, jwtid: crypto.randomUUID() }
  );
}

function generateRefreshToken(user) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { sub: user._id.toString(), type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TTL, jwtid: jti }
  );
  return { token, jti };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setRefreshCookie(res, token) {
  res.cookie('kukora_refresh', token, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: IS_PROD ? 'strict' : 'lax',
    maxAge:   REFRESH_TTL_MS,
    path:     '/api/auth',
  });
}

function clearRefreshCookie(res) {
  res.clearCookie('kukora_refresh', { path: '/api/auth' });
}

// ─── Auth middleware ───────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Authentication required', code: 'NO_TOKEN' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    // Issue 19: Check jti blacklist so password-change revokes access tokens immediately
    if (payload.jti) {
      const blacklisted = await TokenBlacklist.findOne({ jti: payload.jti }).lean().catch(() => null);
      if (blacklisted) {
        return res.status(401).json({ ok: false, error: 'Token revoked', code: 'TOKEN_REVOKED' });
      }
    }
    req.user   = payload;
    req.userId = payload.sub;
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ ok: false, error: 'Invalid token', code: 'TOKEN_INVALID' });
  }
}

// H-7 fix (Sesión 20, ver MIGRATION_CLEANUP_LOG.md): el campo `role` del
// User model (server/models.js) existía desde el principio (enum
// ['user','admin'], default 'user') y ya viaja dentro del JWT (ver
// generateAccessToken() arriba: `role: user.role`), pero ningún middleware
// lo leía — cualquier usuario autenticado podía golpear endpoints
// destructivos/administrativos (resetear el circuit breaker, activar
// escenarios de stress-test, forzar rebalanceos, cambiar el modo de
// trading) exactamente igual que un admin. requireRole() cierra ese gap
// leyendo `req.user.role` (ya poblado por requireAuth desde el JWT, sin
// necesidad de un roundtrip a DB) y exige que sea uno de los roles
// permitidos, devolviendo 403 explícito en vez de dejarlo pasar.
//
// DEBE montarse siempre después de requireAuth (depende de req.user).
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Authentication required', code: 'NO_TOKEN' });
    }
    const role = req.user.role || 'user';
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        ok: false,
        error: `Forbidden: requires role ${allowedRoles.join(' or ')}`,
        code: 'INSUFFICIENT_ROLE',
      });
    }
    next();
  };
}

// Hybrid: JWT if present, fall back to session header (backward compat)
function hybridAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      req.user   = payload;
      req.userId = payload.sub;
    } catch { /* fall through to sessionMiddleware userId */ }
  }
  next();
}

// ─── POST /api/auth/register ──────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || typeof email !== 'string') return res.status(400).json({ ok: false, error: 'Valid email required' });
  if (!password || password.length < 8)    return res.status(400).json({ ok: false, error: 'Password must be ≥ 8 characters' });

  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ ok: false, error: 'Authentication service temporarily unavailable. Please try again.', code: 'DB_UNAVAILABLE' });
  }

  try {
    if (await User.findOne({ email: email.toLowerCase().trim() })) {
      return res.status(409).json({ ok: false, error: 'Email already registered' });
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    let user = await User.create({ email: email.toLowerCase().trim(), passwordHash, name: (name || '').trim() });
    user = await _syncRole(user);

    const accessToken = generateAccessToken(user);
    const { token: refreshToken } = generateRefreshToken(user);
    await User.findByIdAndUpdate(user._id, { refreshTokenHash: hashToken(refreshToken), lastLoginAt: new Date() });

    setRefreshCookie(res, refreshToken);
    logger.info('auth', 'User registered', { userId: user._id });
    res.status(201).json({
      ok: true,
      data: { accessToken, user: { id: user._id, email: user.email, name: user.name, role: user.role, authProvider: user.authProvider, avatarUrl: user.avatarUrl } },
    });
  } catch (e) {
    logger.error('auth', 'Register error', { err: e.message });
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  // Security phase (2026-07-09): explicit type check, matching /register's
  // existing pattern. Without this, a non-string email/password (e.g. a
  // NoSQL-injection probe like { "$gt": "" }) reached User.findOne()'s
  // .toLowerCase() call and only degraded to a generic 500 via the
  // surrounding try/catch — no bypass was possible, but it's an
  // undocumented inconsistency with /register and the wrong way to reject
  // a malformed request (500 instead of 400).
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Email and password required' });
  }

  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ ok: false, error: 'Authentication service temporarily unavailable. Please try again.', code: 'DB_UNAVAILABLE' });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      await bcrypt.hash('dummy', 1); // constant-time
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }
    if (!user.passwordHash) {
      // Account was created via Google Sign-In and never set a local password
      await bcrypt.hash('dummy', 1); // constant-time, avoid leaking provider via timing
      return res.status(401).json({
        ok: false,
        error: 'This account uses Google Sign-In. Continue with Google instead.',
        code: 'GOOGLE_ACCOUNT',
      });
    }
    if (!await bcrypt.compare(password, user.passwordHash)) {
      // Security phase (2026-07-09): a wrong-password attempt against a
      // real, known account is the actionable brute-force/credential-
      // stuffing signal (unlike "email not found", which is cheap for an
      // attacker to trigger at random and less useful to alert on). Logs
      // userId only, never the raw email/password, to avoid putting
      // credentials in logs.
      logger.warn('auth', 'Failed login attempt (wrong password)', { userId: user._id });
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }
    await _syncRole(user);

    const accessToken = generateAccessToken(user);
    const { token: refreshToken } = generateRefreshToken(user);
    await User.findByIdAndUpdate(user._id, { refreshTokenHash: hashToken(refreshToken), lastLoginAt: new Date() });

    setRefreshCookie(res, refreshToken);
    logger.info('auth', 'User logged in', { userId: user._id });
    res.json({
      ok: true,
      data: { accessToken, user: { id: user._id, email: user.email, name: user.name, role: user.role, authProvider: user.authProvider, avatarUrl: user.avatarUrl } },
    });
  } catch (e) {
    logger.error('auth', 'Login error', { err: e.message });
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

// ─── POST /api/auth/google ─────────────────────────────────────────────────
// Frontend signs in with the Firebase Google provider, then sends us the
// resulting Firebase ID token. We verify it server-side (never trust a
// client-asserted email), then:
//   - existing account with this googleId  → log in
//   - existing local account, same email   → link the Google identity to it
//   - no account with this email           → create a new Google-only user
// Either way we mint our own access/refresh JWT pair, same as /login — the
// backend remains the single source of authorization, Firebase only proves
// "this person controls this Google account".
router.post('/google', authLimiter, async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing Google ID token' });
  }

  // Fast-fail when the database is unreachable. Without this guard,
  // Mongoose buffers the User.findOne() call for bufferTimeoutMS (6s)
  // after the 5s serverSelectionTimeout, producing a ~11-37s hang
  // followed by a 500. A 503 is semantically correct (service temporarily
  // unavailable) and surfaces the real problem clearly to the client.
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    logger.warn('auth', 'Google sign-in rejected — database not connected', { readyState: mongoose.connection.readyState });
    return res.status(503).json({
      ok: false,
      error: 'Authentication service temporarily unavailable — database is not connected. Please try again in a moment.',
      code: 'DB_UNAVAILABLE',
    });
  }

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (e) {
    if (e.message === 'FIREBASE_NOT_CONFIGURED') {
      logger.error('auth', 'Google sign-in attempted but Firebase is not configured');
      return res.status(503).json({ ok: false, error: 'Google Sign-In is not available right now', code: 'GOOGLE_UNAVAILABLE' });
    }
    return res.status(401).json({ ok: false, error: 'Invalid or expired Google session', code: 'GOOGLE_TOKEN_INVALID' });
  }

  const { uid, email, name, picture, email_verified } = decoded;
  if (!email || !email_verified) {
    return res.status(401).json({ ok: false, error: 'Google account email could not be verified' });
  }

  try {
    let user = await User.findOne({ googleId: uid });

    if (!user) {
      // No account linked to this Google identity yet — check by email so
      // an existing local account gets linked instead of duplicated.
      user = await User.findOne({ email: email.toLowerCase().trim() });
      if (user) {
        user.googleId = uid;
        if (!user.avatarUrl && picture) user.avatarUrl = picture;
        await user.save();
        logger.info('auth', 'Linked Google identity to existing account', { userId: user._id });
      } else {
        user = await User.create({
          email: email.toLowerCase().trim(),
          name: (name || '').trim(),
          avatarUrl: picture || '',
          authProvider: 'google',
          googleId: uid,
          passwordHash: null,
        });
        logger.info('auth', 'Created new user via Google Sign-In', { userId: user._id });
      }
    }

    await _syncRole(user);

    const accessToken = generateAccessToken(user);
    const { token: refreshToken } = generateRefreshToken(user);
    await User.findByIdAndUpdate(user._id, { refreshTokenHash: hashToken(refreshToken), lastLoginAt: new Date() });

    setRefreshCookie(res, refreshToken);
    res.json({
      ok: true,
      data: {
        accessToken,
        user: { id: user._id, email: user.email, name: user.name, role: user.role, authProvider: user.authProvider, avatarUrl: user.avatarUrl },
      },
    });
  } catch (e) {
    // Duplicate-key race (two simultaneous sign-ins linking the same email)
    if (e.code === 11000) {
      return res.status(409).json({ ok: false, error: 'Account already linked. Please try signing in again.' });
    }
    logger.error('auth', 'Google sign-in error', { err: e.message });
    res.status(500).json({ ok: false, error: 'Google sign-in failed' });
  }
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.kukora_refresh;
  if (!refreshToken) return res.status(401).json({ ok: false, error: 'No refresh token', code: 'NO_REFRESH' });

  // Same fast-fail as /register and /login: without this, a stale
  // refresh cookie (e.g. left over from a previous session) sends this
  // route straight into TokenBlacklist.findOne()/User.findById() with no
  // readyState check, so when MongoDB is unreachable the request blocks
  // for the full ~6s serverSelectionTimeoutMS + connectTimeoutMS window
  // before the catch block below ever runs. Checking readyState first
  // returns 503 in milliseconds instead.
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ ok: false, error: 'Authentication service temporarily unavailable. Please try again.', code: 'DB_UNAVAILABLE' });
  }

  try {
    const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    if (payload.type !== 'refresh') throw new Error('Wrong type');

    if (await TokenBlacklist.findOne({ jti: payload.jti })) {
      return res.status(401).json({ ok: false, error: 'Token revoked', code: 'TOKEN_REVOKED' });
    }

    const user = await User.findById(payload.sub);
    if (!user || user.refreshTokenHash !== hashToken(refreshToken)) {
      // Security phase (2026-07-09): this branch is the system's actual
      // stolen-refresh-token detector (see file header: "detección de reuso
      // de token — indica robo de refresh token si el hash almacenado no
      // coincide"), but it never left a trace anywhere before this fix —
      // no log line, so no way to alert on or investigate a pattern of
      // this happening. A single hit can be an expired/rotated session; a
      // burst of hits for the same userId is exactly the signal a real
      // incident-response process would want to catch.
      logger.warn('auth', 'Refresh token reuse detected (stolen/already-rotated token)', {
        userId: payload.sub,
        jti: payload.jti,
      });
      return res.status(401).json({ ok: false, error: 'Token invalid', code: 'TOKEN_REUSE' });
    }

    const newAccessToken = generateAccessToken(user);
    const { token: newRefreshToken } = generateRefreshToken(user);
    await TokenBlacklist.create({ jti: payload.jti, expiresAt: new Date(payload.exp * 1000) });
    await User.findByIdAndUpdate(user._id, { refreshTokenHash: hashToken(newRefreshToken) });

    setRefreshCookie(res, newRefreshToken);
    res.json({ ok: true, data: { accessToken: newAccessToken } });
  } catch (e) {
    clearRefreshCookie(res);
    return res.status(401).json({ ok: false, error: 'Invalid or expired refresh token', code: 'REFRESH_INVALID' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  const refreshToken = req.cookies?.kukora_refresh;
  try {
    if (refreshToken) {
      const payload = jwt.decode(refreshToken);
      if (payload?.jti) {
        await TokenBlacklist.create({
          jti: payload.jti,
          expiresAt: new Date((payload.exp || Date.now() / 1000 + 86400) * 1000),
        }).catch(() => {});
      }
    }
    await User.findByIdAndUpdate(req.userId, { refreshTokenHash: null });
    clearRefreshCookie(res);
    res.json({ ok: true });
  } catch (e) {
    clearRefreshCookie(res);
    res.json({ ok: true });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash -refreshTokenHash');
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, data: { user } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not fetch profile' });
  }
});

// ─── PATCH /api/auth/me ───────────────────────────────────────────────────
// Whitelisted, partial-update profile patch. Only known-safe fields are
// ever forwarded to Mongo — anything else in the body is silently ignored
// rather than rejected, so a client sending extra UI-only fields doesn't
// break the request.
router.patch('/me', requireAuth, async (req, res) => {
  const body = req.body || {};
  const update = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
      return res.status(400).json({ ok: false, error: 'Valid name required (1-80 chars)' });
    }
    update.name = body.name.trim();
  }

  if (body.onboardingDone !== undefined) {
    update.onboardingDone = Boolean(body.onboardingDone);
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid fields to update' });
  }

  try {
    const user = await User.findByIdAndUpdate(req.userId, update, { new: true })
      .select('-passwordHash -refreshTokenHash');
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, data: { user } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

// ─── POST /api/auth/change-password ───────────────────────────────────────
// Requires the current password to prevent a stolen/lingering access token
// from silently taking over the account. On success, every refresh token
// is invalidated (refreshTokenHash cleared) so any other open session is
// logged out — standard practice for a credential change.
router.post('/change-password', authLimiter, requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({ ok: false, error: 'Current password required' });
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: 'New password must be ≥ 8 characters' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    if (!user.passwordHash) {
      return res.status(400).json({
        ok: false,
        error: 'This account signs in with Google and has no local password to change.',
        code: 'GOOGLE_ACCOUNT',
      });
    }

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await User.findByIdAndUpdate(req.userId, { passwordHash, refreshTokenHash: null });

    // Issue 19: Blacklist current access token so it's immediately invalid
    if (req.user?.jti) {
      const accessPayload = req.user;
      await TokenBlacklist.create({
        jti: accessPayload.jti,
        expiresAt: new Date((accessPayload.exp || (Date.now() / 1000 + 900)) * 1000),
      }).catch(() => {});
    }

    clearRefreshCookie(res);

    logger.info('auth', 'Password changed', { userId: req.userId });
    res.json({ ok: true, data: { message: 'Password updated. Please sign in again.' } });
  } catch (e) {
    logger.error('auth', 'Change password error', { err: e.message });
    res.status(500).json({ ok: false, error: 'Could not change password' });
  }
});

module.exports = { router, requireAuth, requireRole, hybridAuth, JWT_SECRET, JWT_REFRESH_SECRET };

// ─── Stream Tickets (C-2 fix: elimina JWT en URL para SSE) ───────────────────
// Un ticket de un solo uso con TTL de 30s, asociado al userId.
// El cliente pide POST /api/auth/stream-ticket → { ticket, expiresIn: 30 }
// y lo usa como ?ticket= en la URL del SSE. El servidor lo valida UNA VEZ
// y lo invalida inmediatamente: nunca queda en logs como un JWT real.
//
// Audit fix 1.2 — Redis-backed ticket store for horizontal scaling.
// ────────────────────────────────────────────────────────────────
// Previously this was a plain in-memory Map. That works for a single Node
// process, but breaks the moment Kukora runs behind a load balancer with
// 2+ instances: a ticket created by instance A is invisible to instance B,
// so an SSE connection routed to a different instance than the one that
// issued the ticket gets a spurious 401.
//
// Fix: tickets now live in Redis (when REDIS_URL is configured), using
// native key TTL (SET ... PX 30000) instead of a manual cleanup interval,
// and GETDEL for atomic one-time-use consumption. Any Node instance can now
// validate a ticket issued by any other instance.
//
// REDIS_URL is OPTIONAL — exactly like MONGODB_URI elsewhere in this app.
// Without it, Kukora transparently falls back to the original in-memory Map,
// so local dev and single-instance deployments keep working with zero setup.
const REDIS_URL      = process.env.REDIS_URL || '';
const TICKET_TTL_MS  = 30_000;
const TICKET_PREFIX  = 'kukora:stream-ticket:';

let _redis = null;
let _redisReady = false;

if (REDIS_URL) {
  try {
    // eslint-disable-next-line global-require -- optional dependency, only loaded if configured
    const Redis = require('ioredis');
    _redis = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    _redis.on('connect', () => {
      _redisReady = true;
      logger.info('auth', 'Redis connected — stream tickets are now shared across instances');
    });
    _redis.on('error', (err) => {
      // Non-fatal: every call site below falls back to the in-memory Map
      // if Redis is unavailable, so a transient Redis outage degrades
      // gracefully to single-instance behavior instead of crashing.
      _redisReady = false;
      logger.warn('auth', 'Redis error (falling back to in-memory stream tickets)', { err: err.message });
    });
  } catch (e) {
    logger.warn('auth', "ioredis not installed — run 'npm install ioredis' to enable Redis-backed stream tickets. Falling back to in-memory store.", { err: e.message });
    _redis = null;
  }
} else {
  logger.info('auth', 'REDIS_URL not set — stream tickets use in-memory store (fine for a single instance; set REDIS_URL to share tickets across horizontally-scaled instances)');
}

// In-memory fallback store — used when REDIS_URL is unset or Redis is down.
const _streamTickets = new Map(); // ticket → { userId, expiresAt }

// Cleans expired in-memory tickets every 60s. Only relevant for the fallback
// path — Redis keys expire natively via PX and need no manual sweep.
// .unref() ensures this interval doesn't keep the process alive during graceful shutdown
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _streamTickets) {
    if (now > v.expiresAt) _streamTickets.delete(k);
  }
}, 60_000).unref();

async function createStreamTicket(userId) {
  const ticket = crypto.randomBytes(32).toString('hex');

  if (_redis && _redisReady) {
    try {
      await _redis.set(TICKET_PREFIX + ticket, userId, 'PX', TICKET_TTL_MS);
      return { ticket, expiresIn: 30 };
    } catch (e) {
      logger.warn('auth', 'Redis SET failed for stream ticket, using in-memory fallback', { err: e.message });
      // fall through to in-memory store below
    }
  }

  const expiresAt = Date.now() + TICKET_TTL_MS;
  _streamTickets.set(ticket, { userId, expiresAt });
  return { ticket, expiresIn: 30 };
}

async function consumeStreamTicket(ticket) {
  if (!ticket) return null;

  if (_redis && _redisReady) {
    try {
      // GETDEL is atomic: two concurrent requests for the same ticket can
      // never both succeed, preserving the one-time-use guarantee across
      // multiple Node instances sharing the same Redis.
      const userId = typeof _redis.getdel === 'function'
        ? await _redis.getdel(TICKET_PREFIX + ticket)
        : await (async () => {
            // ioredis versions < 5 lack GETDEL — emulate atomically with a Lua script.
            const result = await _redis.eval(
              "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v",
              1, TICKET_PREFIX + ticket
            );
            return result;
          })();
      if (userId) return userId;
      // Not found in Redis — could be a ticket that was created while Redis
      // was briefly down and landed in the in-memory map instead. Fall through.
    } catch (e) {
      logger.warn('auth', 'Redis GETDEL failed for stream ticket, checking in-memory fallback', { err: e.message });
    }
  }

  const entry = _streamTickets.get(ticket);
  if (!entry) return null;
  _streamTickets.delete(ticket); // one-time use
  if (Date.now() > entry.expiresAt) return null;
  return entry.userId;
}

// POST /api/auth/stream-ticket — requiere JWT válido, devuelve ticket efímero
router.post('/stream-ticket', requireAuth, async (req, res) => {
  try {
    const { ticket, expiresIn } = await createStreamTicket(req.userId);
    res.json({ ok: true, ticket, expiresIn });
  } catch (e) {
    logger.error('auth', 'Failed to create stream ticket', { err: e.message });
    res.status(500).json({ ok: false, error: 'Could not create stream ticket' });
  }
});

module.exports.createStreamTicket  = createStreamTicket;
module.exports.consumeStreamTicket = consumeStreamTicket;

// L-2: expose Redis connectivity for /health and /api/readiness. Mirrors
// the "configured vs connected" distinction already used for MongoDB
// (isDbReady()-style checks) — REDIS_URL unset is a supported in-memory
// mode, not a degraded one, so callers must be able to tell the two apart.
function getRedisStatus() {
  return { configured: !!REDIS_URL, connected: !!(_redis && _redisReady) };
}
module.exports.getRedisStatus = getRedisStatus;