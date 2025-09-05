import express from 'express';
import Redis from 'ioredis';
import amqp from 'amqplib';
import { migrate, pool } from './db.js';

const app = express();
app.use(express.json());

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: +(process.env.REDIS_PORT || 6379),
});

let amqpConn;
async function mq() {
  if (!amqpConn) {
    amqpConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  }
  return amqpConn;
}

let hits = 0;
setInterval(() => (hits = 0), 1000);
app.use((req, res, next) => {
  if (++hits > 200) return res.status(429).json({ error: 'rate limit' });
  next();
});

app.get('/health', async (_req, res) => {
  try {
    if (typeof pool !== 'undefined' && pool) await pool.query('SELECT 1');
    const redisReady = typeof redis !== 'undefined' ? (redis.status === 'ready') : null;
    const amqpConnected = (typeof ch !== 'undefined' && ch) ? true : false;
    return res.json({ service: 'payment', ok: true, db: !!pool, redis_connected: redisReady, amqp_connected: amqpConnected });
  } catch (err) {
    console.error('[payment] /health failed', err && err.message);
    return res.status(500).json({ service: 'payment', ok: false });
  }
});

// ---- charge webhook -----------------------------------------------
// POST /webhooks/payment/charge { reservationId }
// Returns: { ok, message, reservation: { id, event_name, start_time, ticket_type, qty, status } }
app.post('/webhooks/payment/charge', async (req, res) => {
  try {
    const { reservationId } = req.body || {};
    if (!reservationId) return res.status(400).json({ error: 'reservationId required' });

    // In a real system: verify PSP signature & capture funds here.

    const INVENTORY_HOST = process.env.INVENTORY_HOST || 'http://inventory:8080';
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 8000); 

    const r = await fetch(`${INVENTORY_HOST}/inventory/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservationId }),
      signal: controller.signal,
    }).catch(err => {
      throw new Error(`inventory commit failed: ${err.message}`);
    });
    clearTimeout(to);

    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await r.json() : await r.text();

    if (!r.ok || (data && data.ok === false)) {
      const msg = (data && (data.error || data.message)) || `inventory ${r.status}`;
      return res.status(409).json({ ok: false, error: msg });
    }

    const payload = typeof data === 'object' && data ? data : {};
    return res.json({
      ok: true,
      message: payload.message || 'payment authorized & inventory committed',
      reservation: payload.reservation || null,
    });
  } catch (err) {
    console.error('charge failed:', err);
    return res.status(500).json({ error: 'charge failed' });
  }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log('[payment] listening on', PORT);
});

// Graceful shutdown
let shuttingDown = false;
async function graceful() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[payment] shutting down...');
  try { await new Promise(resolve => server.close(resolve)); } catch (e) { console.error('[payment] server.close error', e && e.message); }

  try { if (typeof pool?.end === 'function') await pool.end(); } catch (e) { console.error('[payment] pool.end error', e && e.message); }
  try { if (typeof redis?.quit === 'function') await redis.quit(); } catch (e) { /* ignore */ }
  try { if (typeof ch !== 'undefined' && ch) await ch.close(); } catch (e) { /* ignore */ }
  try { if (typeof amqpConn !== 'undefined' && amqpConn) await amqpConn.close(); } catch (e) { /* ignore */ }

  process.exit(0);
}
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);

