// notification/src/index.js
import express from 'express';
import Redis from 'ioredis';
import amqp from 'amqplib';
import { migrate } from './db.js';

const app = express();
app.use(express.json());

// Redis (kept from original)
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: +(process.env.REDIS_PORT || 6379)
});

// AMQP state
let amqpConn = null;
let ch = null;
let shuttingDown = false;

const RABBIT_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const QUEUE_NAME = process.env.NOTIFY_QUEUE || 'notifications';

// small helper
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Connect to RabbitMQ with exponential backoff and attach handlers.
 * This will keep retrying until successful or process is shutting down.
 */
async function connectWithRetry() {
  let attempt = 0;
  while (!shuttingDown) {
    attempt++;
    try {
      console.log(`[notification] attempting AMQP connect (${attempt}) -> ${RABBIT_URL}`);
      amqpConn = await amqp.connect(RABBIT_URL);

      amqpConn.on('error', (err) => {
        // 'error' event emitted for connection-level errors
        console.error('[notification] AMQP connection error:', err && err.message);
      });

      amqpConn.on('close', () => {
        // connection closed — ensure we drop channel and re-connect
        console.error('[notification] AMQP connection closed');
        ch = null;
        amqpConn = null;
        if (!shuttingDown) {
          // start a reconnect loop (don't await here to avoid blocking)
          connectWithRetry().catch(e => console.error('[notification] reconnect failed', e && e.message));
        }
      });

      // create channel and setup queue and consumer
      ch = await amqpConn.createChannel();
      await ch.assertQueue(QUEUE_NAME, { durable: true });
      await ch.assertQueue('notifications_dlq', { durable: true });

      // consumer: process messages from the notifications queue
      // idempotent, DLQ-backed consumer
await ch.consume(QUEUE_NAME, async (msg) => {
  if (!msg) return;
  const content = msg.content.toString();
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (err) {
    console.error('[notification] failed to parse incoming message, sending to DLQ', err && err.message);
    try { await ch.sendToQueue('notifications_dlq', Buffer.from(content), { persistent: true }); } catch (e) { console.error('[notification] DLQ send failed', e && e.message); }
    try { ch.ack(msg); } catch (_) { /* ignore */ }
    return;
  }

  const reservationId = payload?.reservation?.id || payload?.to;
  if (!reservationId) {
    console.warn('[notification] message missing reservation id, sending to DLQ');
    try { await ch.sendToQueue('notifications_dlq', Buffer.from(content), { persistent: true }); } catch (e) { console.error('[notification] DLQ send failed', e && e.message); }
    try { ch.ack(msg); } catch (_) { /* ignore */ }
    return;
  }

  const processedKey = `notifications:processed:${reservationId}`;
  const processedTtl = +(process.env.PROCESSED_TTL_SECONDS || process.env.PROCESSED_TTL || 60 * 60 * 24); // default 24h

  try {
    // Acquire idempotency claim: SET NX with TTL
    // Note: ioredis uses `EX` before TTL and `NX` after
    const claimed = await redis.set(processedKey, '1', 'EX', processedTtl, 'NX');
    if (!claimed) {
      console.log('[notification] already processed', reservationId);
      try { ch.ack(msg); } catch (_) { /* ignore */ }
      return;
    }

    // Do the work: push audit to list
    const key = `notifications:${reservationId}`;
    const value = JSON.stringify({ payload, receivedAt: new Date().toISOString() });

    const pushed = await redis.lpush(key, value);
    console.log('[notification] lpush OK', { key, pushed });

    // Acknowledge only after success
    try { ch.ack(msg); } catch (_) { /* ignore */ }
  } catch (err) {
    console.error('[notification] processing error for', reservationId, err && (err.message || err));

    // Move to DLQ to avoid repeated redelivery
    try {
      await ch.sendToQueue('notifications_dlq', Buffer.from(content), { persistent: true });
      console.warn('[notification] moved message to DLQ', reservationId);
      try { ch.ack(msg); } catch (_) { /* ignore */ }
    } catch (dlqErr) {
      console.error('[notification] failed to move to DLQ', dlqErr && dlqErr.message ? dlqErr.message : dlqErr);
      // last resort: nack without requeue (drop)
      try { ch.nack(msg, false, false); } catch (e) { console.error('[notification] nack failed', e && e.message); }
    }
  }
}, { noAck: false });


      console.log('[notification] AMQP connected, channel created, queue asserted and consumer started');
      return;
    } catch (err) {
      const waitMs = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 7)));
      console.error(`[notification] AMQP connect attempt ${attempt} failed: ${err && err.message}. retrying in ${waitMs} ms`);
      await wait(waitMs);
    }
  }
}

// health endpoint includes AMQP state
app.get('/health', (_req, res) => {
  res.json({
    service: 'notification',
    ok: true,
    amqp_connected: !!ch,
    redis_connected: !!redis && redis.status === 'ready'
  });
});

/**
 * POST /notify
 * Body (example): { to: 'user@example.com', emailTemplate: 'order-confirm', data: {...} }
 *
 * This endpoint enqueues a notification on the notifications queue so the same process
 * (or other consumers) will pick it up. It's useful for manual testing.
 */
app.post('/notify', async (req, res) => {
  const payload = req.body || {};
  console.log('[notification] /notify called with:', payload);

  if (!ch) {
    // if AMQP isn't ready, return 503 so callers can retry
    return res.status(503).json({ error: 'notification service not ready (no AMQP connection)' });
  }

  try {
    ch.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(payload)), { persistent: true });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[notification] failed to enqueue message', err && err.message);
    return res.status(500).json({ error: 'failed to enqueue' });
  }
});

const PORT = process.env.PORT || 8080;

async function start() {
  try {
    // run migrations first (keeps original behavior)
    await migrate();

    // start HTTP server
    app.listen(PORT, () => {
      console.log('[notification] listening on', PORT);
    });

    // start AMQP connect loop
    connectWithRetry().catch(e => {
      console.error('[notification] AMQP connect fatal', e && e.message);
      process.exit(1);
    });
  } catch (err) {
    console.error('[notification] startup error', err && err.message);
    process.exit(1);
  }
}

start();

// graceful shutdown
async function graceful() {
  shuttingDown = true;
  console.log('[notification] shutting down...');
  try { if (ch) await ch.close(); } catch (e) { /* ignore */ }
  try { if (amqpConn) await amqpConn.close(); } catch (e) { /* ignore */ }
  try { await redis.quit(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);
