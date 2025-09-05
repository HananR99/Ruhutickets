import jwt from 'jsonwebtoken';

const allowlist = new Set([
  '/health',
  '/',
  '/index.html',
  '/login.html',
  '/favicon.ico',
  '/auth/login'
]);

export const requireAuth = (roles = []) => (req, res, next) => {
  try {
    // allow static + health + login + auth
    if (allowlist.has(req.path) || req.path.startsWith('/assets') || req.path.startsWith('/static')) return next();

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'missing token' });

    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (process.env.JWT_AUD && claims.aud !== process.env.JWT_AUD) return res.status(401).json({ error: 'bad aud' });
    if (process.env.JWT_ISS && claims.iss !== process.env.JWT_ISS) return res.status(401).json({ error: 'bad iss' });

    if (roles.length && !roles.includes(claims.role)) return res.status(403).json({ error: 'forbidden' });

    req.user = claims;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
};