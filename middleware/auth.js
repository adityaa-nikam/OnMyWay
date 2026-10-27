const crypto = require('crypto');
const { repo } = require('../db');

const COOKIE_NAME = 'omw_session';
const CSRF_COOKIE = 'omw_csrf';

function hashToken(rawToken) {
  if (typeof rawToken !== 'string') return '';
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Express middleware to authenticate session cookie
 */
function sessionMiddleware(req, res, next) {
  const sessionToken = req.cookies?.[COOKIE_NAME] || req.cookies?.['rt_session'];

  // Ensure CSRF cookie exists
  if (!req.cookies?.[CSRF_COOKIE]) {
    const csrfToken = crypto.randomBytes(16).toString('hex');
    res.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false, // Accessible to client JavaScript for setting X-CSRF-Token header
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/'
    });
    req.csrfToken = csrfToken;
  } else {
    req.csrfToken = req.cookies[CSRF_COOKIE];
  }

  if (!sessionToken) {
    req.user = null;
    req.session = null;
    return next();
  }

  const tokenHash = hashToken(sessionToken);
  const session = repo.getSession(tokenHash);

  if (session) {
    req.user = session.user;
    req.session = session;
  } else {
    req.user = null;
    req.session = null;
    // Clear invalid session cookie
    res.clearCookie(COOKIE_NAME);
    res.clearCookie('rt_session');
  }

  next();
}

/**
 * Route protection: requires authenticated user
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      const returnUrl = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?returnUrl=${returnUrl}`);
    }
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  next();
}

/**
 * CSRF Protection for state-changing HTTP requests
 */
function verifyCsrf(req, res, next) {
  // Safe methods pass through
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Exempt auth magic link submission and verify POST
  if (req.path === '/auth/magic-link' || req.path === '/auth/verify' || req.path.startsWith('/api/rooms')) {
    return next();
  }

  const expectedCsrf = req.cookies?.[CSRF_COOKIE];
  const clientCsrf = req.headers['x-csrf-token'] || req.body?._csrf;

  if (!expectedCsrf || !clientCsrf) {
    return res.status(403).json({ success: false, error: 'Missing CSRF token' });
  }

  const expectedBuf = Buffer.from(expectedCsrf);
  const clientBuf = Buffer.from(clientCsrf);

  if (expectedBuf.length !== clientBuf.length || !crypto.timingSafeEqual(expectedBuf, clientBuf)) {
    return res.status(403).json({ success: false, error: 'Invalid CSRF token' });
  }

  next();
}

/**
 * Socket.IO CSWSH Origin Verification & Handshake Auth
 */
function socketAuthMiddleware(socket, next) {
  const origin = socket.handshake.headers.origin;
  const host = socket.handshake.headers.host;

  // 1. Origin verification (CSWSH Defense)
  if (origin) {
    try {
      const url = new URL(origin);
      let allowed = false;

      // Allow same host
      if (host && (url.host === host || url.hostname === host.split(':')[0])) {
        allowed = true;
      } else if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        allowed = true;
      } else if (process.env.APP_ORIGIN && url.origin === process.env.APP_ORIGIN) {
        allowed = true;
      }

      if (!allowed) {
        console.warn(`[CSWSH BLOCKED] Unauthorized origin attempted connection: ${origin}`);
        return next(new Error('Cross-Site WebSocket Hijacking (CSWSH) blocked: invalid origin'));
      }
    } catch (e) {
      return next(new Error('Cross-Site WebSocket Hijacking (CSWSH) blocked: malformed origin'));
    }
  }

  // 2. Parse cookies from handshake
  const rawCookie = socket.handshake.headers.cookie;
  if (!rawCookie) {
    socket.data.user = null;
    return next();
  }

  const cookies = {};
  rawCookie.split(';').forEach((part) => {
    const [key, val] = part.trim().split('=');
    if (key && val) cookies[key] = decodeURIComponent(val);
  });

  const sessionToken = cookies[COOKIE_NAME] || cookies['rt_session'];
  if (!sessionToken) {
    socket.data.user = null;
    return next();
  }

  const tokenHash = hashToken(sessionToken);
  const session = repo.getSession(tokenHash);

  if (session) {
    socket.data.user = session.user;
  } else {
    socket.data.user = null;
  }

  next();
}

module.exports = {
  COOKIE_NAME,
  CSRF_COOKIE,
  hashToken,
  sessionMiddleware,
  requireAuth,
  verifyCsrf,
  socketAuthMiddleware
};
