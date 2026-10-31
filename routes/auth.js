const express = require('express');
const crypto = require('crypto');
const { repo } = require('../db');
const { sendMagicLinkEmail } = require('../services/mailer');
const { COOKIE_NAME, hashToken, requireAuth } = require('../middleware/auth');
const { RateLimiter } = require('../roomManager');

const router = express.Router();

// Strict sliding-window rate limiters for auth endpoints
const magicLinkLimiter = new RateLimiter(5, 5 * 60 * 1000); // Max 5 requests per 5 minutes per IP
const verifyLimiter = new RateLimiter(10, 60 * 1000); // Max 10 verification attempts per minute per IP

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Render login page
router.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/groups');
  }
  res.render('login', {
    returnUrl: req.query.returnUrl || '',
    error: req.query.error || null,
    sent: req.query.sent === 'true',
    email: req.query.email || '',
    devLink: req.query.devLink || null
  });
});

// Request a passwordless magic link
router.post('/auth/magic-link', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!magicLinkLimiter.consume(ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Please slow down and try again in a few minutes.' });
  }

  const { email, returnUrl } = req.body;
  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim()) || email.length > 254) {
    return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15-minute single-use validity

  repo.createAuthToken({ tokenHash, email: cleanEmail, expiresAt });

  const baseUrl = process.env.APP_URL || `${req.protocol || 'http'}://${req.get('host') || 'localhost:3000'}`;
  const verifyUrl = `${baseUrl}/auth/verify?token=${rawToken}${returnUrl ? `&returnUrl=${encodeURIComponent(returnUrl)}` : ''}`;

  try {
    await sendMagicLinkEmail({ to: cleanEmail, magicLinkUrl: verifyUrl });
  } catch (err) {
    console.error('Failed to send magic link email:', err);
    return res.status(500).json({ success: false, error: 'Unable to deliver sign-in email. Please check your SMTP settings and try again.' });
  }

  if (req.accepts('html') && !req.xhr) {
    const isDev = !(process.env.SMTP_USER && (process.env.SMTP_HOST || process.env.SMTP_SERVICE));
    const devParam = isDev ? `&devLink=${encodeURIComponent(verifyUrl)}` : '';
    return res.redirect(`/login?sent=true&email=${encodeURIComponent(cleanEmail)}${devParam}`);
  }

  res.json({ success: true, message: 'Magic link sent successfully. Please check your inbox.' });
});

// Magic link landing page: GET renders confirmation page to defeat anti-virus/scanner crawlers
router.get('/auth/verify', (req, res) => {
  const { token, returnUrl } = req.query;
  if (!token || typeof token !== 'string') {
    return res.render('auth-confirm', {
      valid: false,
      error: 'Invalid or missing sign-in token.',
      token: '',
      returnUrl: ''
    });
  }

  const tokenHash = hashToken(token);
  const record = repo.getAuthToken(tokenHash);

  if (!record) {
    return res.render('auth-confirm', {
      valid: false,
      error: 'Sign-in link is invalid or does not exist.',
      token: '',
      returnUrl: ''
    });
  }

  if (record.used_at) {
    return res.render('auth-confirm', {
      valid: false,
      error: 'This single-use sign-in link has already been used.',
      token: '',
      returnUrl: ''
    });
  }

  if (Date.now() > record.expiresAt) {
    return res.render('auth-confirm', {
      valid: false,
      error: 'This sign-in link has expired (15-minute limit). Please request a new one.',
      token: '',
      returnUrl: ''
    });
  }

  res.render('auth-confirm', {
    valid: true,
    error: null,
    token,
    returnUrl: returnUrl || '',
    email: record.email
  });
});

// Explicit POST click confirmation to consume the magic link token
router.post('/auth/verify', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!verifyLimiter.consume(ip)) {
    return res.status(429).json({ success: false, error: 'Too many verification attempts. Please wait.' });
  }

  const { token, returnUrl } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing sign-in token.' });
  }

  const tokenHash = hashToken(token);
  const record = repo.getAuthToken(tokenHash);

  if (!record) {
    return res.status(400).json({ success: false, error: 'Sign-in link is invalid or does not exist.' });
  }

  if (record.used_at) {
    return res.status(400).json({ success: false, error: 'This sign-in link has already been used.' });
  }

  if (Date.now() > record.expiresAt) {
    return res.status(400).json({ success: false, error: 'This sign-in link has expired.' });
  }

  // Atomically mark token as used
  const marked = repo.markAuthTokenUsed(tokenHash);
  if (!marked) {
    return res.status(400).json({ success: false, error: 'This sign-in link has already been used.' });
  }

  // Find or create user
  let user = repo.getUserByEmail(record.email);
  if (!user) {
    const defaultName = record.email.split('@')[0].slice(0, 25) || 'User';
    user = repo.createUser({
      email: record.email,
      displayName: defaultName
    });
  }

  // Generate session token (raw in cookie, SHA-256 in DB)
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionHash = hashToken(sessionToken);
  const sessionExpiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days

  repo.createSession({
    tokenHash: sessionHash,
    userId: user.id,
    expiresAt: sessionExpiresAt
  });

  // Set secure httpOnly cookie
  res.cookie(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });

  // Also set backwards-compatible rt_session cookie
  res.cookie('rt_session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });

  const redirectTarget = (returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//'))
    ? returnUrl
    : '/groups';
  const wantsJson = Boolean(req.xhr || req.is('json') || (req.headers.accept && req.headers.accept.includes('application/json')));
  if (!wantsJson && req.accepts('html')) {
    return res.redirect(redirectTarget);
  }

  res.json({ success: true, redirect: redirectTarget, user });
});

// Logout (handles both GET and POST)
router.all('/auth/logout', (req, res) => {
  const sessionToken = req.cookies?.[COOKIE_NAME] || req.cookies?.['rt_session'];
  if (sessionToken) {
    repo.deleteSession(hashToken(sessionToken));
  }
  res.clearCookie(COOKIE_NAME);
  res.clearCookie('rt_session');

  if (req.accepts('html') && !req.xhr && !req.is('json')) {
    return res.redirect('/');
  }
  res.json({ success: true });
});

// Account deletion with cascade
router.delete('/api/account', requireAuth, (req, res) => {
  const userId = req.user.id;
  const deleted = repo.deleteUser(userId);

  res.clearCookie(COOKIE_NAME);
  res.clearCookie('rt_session');

  if (!deleted) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  res.json({ success: true, message: 'Account and all associated data permanently deleted.' });
});

module.exports = router;
