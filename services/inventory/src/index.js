import express from 'express';
import Redis from 'ioredis';
import amqp from 'amqplib';
import { migrate } from './db.js';
import { createEventRoute, updateEventRoute, deleteEventRoute,
         listReservationsRoute, ticketTypesRoute, eventsRoute,
         createTicketTypeRoute, reserveRoute, eventStatsRoute } from './routes.js';
import commitRouter from './commit.js';
import { pool } from './db.js';
import { isConnected as amqpIsConnected } from './amqp.js';

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
    if (typeof pool !== 'undefined' && pool) {
      await pool.query('SELECT 1');
    }

    let amqpConnected = null;
    try {
      amqpConnected = typeof amqpIsConnected === 'function' ? amqpIsConnected() : null;
    } catch (e) {
      amqpConnected = false;
    }

    return res.json({
      service: 'inventory',
      ok: true,
      db: !!pool,
      amqp_connected: amqpConnected
    });
  } catch (err) {
    console.error('[inventory] /health check failed', err && (err.message || err));
    return res.status(500).json({ service: 'inventory', ok: false });
  }
});

app.get('/events', eventsRoute);
app.post('/events', createEventRoute);
app.put('/events/:id', updateEventRoute);
app.delete('/events/:id', deleteEventRoute);

app.get('/inventory/ticket-types', ticketTypesRoute);
app.post('/inventory/ticket-types', createTicketTypeRoute);
app.get('/inventory/reservations', listReservationsRoute);
app.get('/inventory/event-stats', eventStatsRoute);

app.post('/inventory/reserve', reserveRoute);
app.use('/inventory', commitRouter); 

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  await migrate();
  await mq();
  console.log('inventory listening on', PORT);
});
