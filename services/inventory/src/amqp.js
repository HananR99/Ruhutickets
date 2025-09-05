import amqplib from 'amqplib';

const AMQP_URL = process.env.AMQP_URL || 'amqp://rabbitmq:5672';
const QUEUE = process.env.NOTIFY_QUEUE || 'notifications';

let conn = null;
let channel = null;
let connecting = false;

async function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

export async function connectWithRetry() {
  if (channel) return channel;
  if (connecting) {
    // wait until connection is ready
    let tries = 0;
    while (!channel && tries < 30) { await wait(500); tries++; }
    return channel;
  }
  connecting = true;
  let attempt = 0;
  while (!channel) {
    try {
      attempt++;
      console.log(`[inventory] attempting AMQP connect (${attempt}) -> ${AMQP_URL}`);
      conn = await amqplib.connect(AMQP_URL);
      conn.on('error', (err) => {
        console.error('[inventory] amqp connection error', err && err.message);
      });
      conn.on('close', async () => {
        console.warn('[inventory] amqp connection closed, will retry');
        channel = null;
        conn = null;
        // try reconnect in background
        setTimeout(() => connectWithRetry().catch(()=>{}), 1000 * Math.min(attempt, 30));
      });

      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE, { durable: true });
      console.log('[inventory] AMQP connected, channel ready');
      connecting = false;
      return channel;
    } catch (err) {
      console.error('[inventory] AMQP connect failed:', err.message || err);
      await wait(Math.min(2000 * attempt, 30000)); 
    }
  }
  connecting = false;
  return channel;
}

/**
 * Publishes a notification payload onto the configured notifications queue.
 * payload should be JSON-serializable.
 */
export async function publishNotification(payload) {
  try {
    const ch = await connectWithRetry();
    const buf = Buffer.from(JSON.stringify(payload));
    // persistent so RabbitMQ stores to disk until acked
    const ok = ch.sendToQueue(QUEUE, buf, { persistent: true });
    if (!ok) console.warn('[inventory] publishNotification sendToQueue returned false (backpressure)');
    return true;
  } catch (err) {
    console.error('[inventory] publishNotification failed', err && err.message);
    return false;
  }
}

export function isConnected() {
  return !!channel;
}