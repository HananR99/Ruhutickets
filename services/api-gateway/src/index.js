import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from './auth.js';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import cors from 'cors';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({
  verify: (req, _res, buf) => {
    try { req.rawBody = buf && buf.toString('utf8'); } catch (e) { req.rawBody = undefined; }
  }
}));

const USERS = {
  'user':  'pass123',
  'admin':  'pass123',
};

// LOGIN endpoint
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!USERS[username] || USERS[username] !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const role = username === 'admin' ? 'admin' : 'buyer';
  const token = jwt.sign(
    { sub: username, role, iss: process.env.JWT_ISS, aud: process.env.JWT_AUD },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ token });
});

// app.use((req, res, next) => {
//   res.header('Access-Control-Allow-Origin', '*'); // dev only
//   res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
//   res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
//   if (req.method === 'OPTIONS') return res.sendStatus(204);
//   next();
// });

app.use(cors({
  origin: ['http://localhost:8081'],          // UI origin
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Authorization','Content-Type'],
  credentials: false
}));

// ---------- simple rate limiter (demo only) ----------
let hits = 0;
setInterval(() => { hits = 0; }, 1000);
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' ||
      req.path === '/health' ||
      req.path === '/' ||
      req.path.startsWith('/favicon') ||
      req.path.startsWith('/assets')) return next();
  if (++hits > 100) return res.status(429).json({ error: 'rate limit' });
  next();
});

// ---------- health ----------
// app.get('/health', (_req, res) => res.json({ service: 'api-gateway', ok: true, amqp_connected: !!ch, redis_connected: !!redis && redis.status === 'ready' }));
app.get('/health', (_req, res) => {
  return res.json({ service: 'api-gateway', ok: true });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get('/',      (_req,res) => res.sendFile(path.join(__dirname,'../public/login.html')));
app.get('/login', (_req,res) => res.sendFile(path.join(__dirname,'../public/login.html')));

app.use(requireAuth());

app.use(express.static(path.join(__dirname,'../public')));

// ---------- tiny proxy helper with /api/v1 -> / rewrite ----------
function proxy(targetHost) {
  return async (req, res) => {
    const rewrittenPath = req.originalUrl.replace(/^\/api\/v1/, '');
    const targetUrl = new URL(rewrittenPath || '/', `http://${targetHost}`);

    const opts = {
      method: req.method,
      headers: {
        // pass through essential headers
        'content-type': req.headers['content-type'] || 'application/json',
        'authorization': req.headers['authorization'] || '',
      }
    };

    const bodyNeeded = !['GET', 'HEAD'].includes(req.method);
    const pReq = http.request(targetUrl, opts, pRes => {
      res.status(pRes.statusCode || 500);
      if (pRes.headers['content-type']) res.setHeader('content-type', pRes.headers['content-type']);
      pRes.pipe(res);
    });

    pReq.on('error', e => res.status(502).json({ error: e.message }));
    if (bodyNeeded && req.body && Object.keys(req.body).length) {
      pReq.write(JSON.stringify(req.body));
    }
    pReq.end();
  };
}

app.get('/api/v1/events', (req, res) => {
  if (!req.user || req.user.role !== 'buyer') {
    return proxy('inventory:8080')(req, res);
  }

  const rewrittenPath = req.originalUrl.replace(/^\/api\/v1/, '');
  const targetUrl = new URL(rewrittenPath || '/', 'http://inventory:8080');

  const opts = {
    method: 'GET',
    headers: {
      'authorization': req.headers['authorization'] || '',
    }
  };

  const pReq = http.request(targetUrl, opts, pRes => {
    const ct = pRes.headers['content-type'] || '';
    const chunks = [];
    pRes.on('data', d => chunks.push(d));
    pRes.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!ct.includes('application/json')) {
        res.status(pRes.statusCode || 200);
        if (ct) res.setHeader('content-type', ct);
        return res.send(buf);
      }

      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); }
      catch { return res.status(502).json({ error: 'bad upstream JSON' }); }

      const now = Date.now();
      const filtered = Array.isArray(payload)
        ? payload.filter(e => {
            const end   = e?.end_time   ? Date.parse(e.end_time)   : NaN;
            const start = e?.start_time ? Date.parse(e.start_time) : NaN;
            if (Number.isFinite(end))   return end   >= now;
            if (Number.isFinite(start)) return start >= now;
            return true;
          })
        : payload;

      res.status(pRes.statusCode || 200).json(filtered);
    });
  });

  pReq.on('error', e => res.status(502).json({ error: e.message }));
  pReq.end();
});

// ---------- routes to backend services ----------
app.use('/api/v1/events',            proxy('inventory:8080'));
app.use('/api/v1/inventory',         proxy('inventory:8080'));
app.use('/api/v1/orders',            proxy('order:8080'));
app.use('/api/v1/webhooks/payment',  proxy('payment:8080'));
app.use('/notify',                   proxy('notification:8080'));

app.use((err, req, res, next) => {
  if (err && err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('[BAD_JSON] parse error:', err.message, 'rawBody=', req.rawBody);
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  next(err);
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log('[api-gateway] listening on', PORT);
});

let shuttingDown = false;
async function graceful() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[api-gateway] shutting down...');
  try { await new Promise(resolve => server.close(resolve)); } catch (e) { console.error('[api-gateway] server.close error', e && e.message); }
  try { if (typeof redis?.quit === 'function') await redis.quit(); } catch (e) { /* ignore */ }
  try { if (typeof ch !== 'undefined' && ch) await ch.close(); } catch (e) { /* ignore */ }
  try { if (typeof amqpConn !== 'undefined' && amqpConn) await amqpConn.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);