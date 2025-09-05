import express from 'express';
import Redis from 'ioredis';
import amqp from 'amqplib';
import { migrate, pool } from './db.js';
import { randomUUID as uuid } from 'crypto';

const app = express();
app.use(express.json());

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: +(process.env.REDIS_PORT||6379) });
let amqpConn;
async function mq() {
  if (!amqpConn) amqpConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  return amqpConn;
}

app.get('/health', async (_req, res) => {
  try {
    if (typeof pool !== 'undefined' && pool) await pool.query('SELECT 1');
    const redisReady = typeof redis !== 'undefined' ? (redis.status === 'ready') : null;
    const amqpConnected = (typeof ch !== 'undefined' && ch) ? true : false;
    return res.json({ service: 'order', ok: true, db: !!pool, redis_connected: redisReady, amqp_connected: amqpConnected });
  } catch (err) {
    console.error('[order] /health failed', err && err.message);
    return res.status(500).json({ service: 'order', ok: false });
  }
});

app.post('/orders', async (req, res) => {
  const { reservationId, paymentMethod = 'mock' } = req.body || {};
  if (!reservationId) return res.status(400).json({ error: 'reservationId required' });
  const id = uuid();
  await pool.query(
    'insert into orders(id,user_id,total_cents,currency,status) values($1,$2,$3,$4,$5)',
    [id, 'user1', 0, 'LKR', 'PENDING']
  );
  res.status(201).json({ id, status: 'PENDING', next: 'pay at /webhooks/payment/charge' });
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log('[order] listening on', PORT);
});
let shuttingDown = false;
async function graceful() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[order] shutting down...');
  try { await new Promise(resolve => server.close(resolve)); } catch (e) { console.error('[order] server.close error', e && e.message); }
  try { if (typeof pool?.end === 'function') await pool.end(); } catch (e) { console.error('[order] pool.end error', e && e.message); }
  try { if (typeof redis?.quit === 'function') await redis.quit(); } catch (e) { /* ignore */ }
  try { if (typeof ch !== 'undefined' && ch) await ch.close(); } catch (e) { /* ignore */ }
  try { if (typeof amqpConn !== 'undefined' && amqpConn) await amqpConn.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);
