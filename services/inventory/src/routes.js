import { pool } from './db.js';
import { randomUUID as uuid } from 'crypto';
import { z } from 'zod';
import Redis from 'ioredis';
const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: +(process.env.REDIS_PORT||6379) });

export const eventsRoute = async (_req, res) => {
  const { rows } = await pool.query('select id,name,venue,start_time,end_time from events order by start_time asc');
  res.json(rows);
};

const CreateEvent = z.object({
  name: z.string().min(2),
  venue: z.string().min(1),
  start_time: z.string(), 
  end_time: z.string(),   
});
export const createEventRoute = async (req,res) => {
  const r = CreateEvent.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: r.error.errors });
  const id = uuid();
  const { name, venue, start_time, end_time } = r.data;
  await pool.query(
    `insert into events(id,name,venue,start_time,end_time) values($1,$2,$3,$4,$5)`,
    [id, name, venue, start_time, end_time]
  );
  res.status(201).json({ id, name, venue, start_time, end_time });
};

// ---------- existing: reserve ----------
const ReserveSchema = z.object({ ticketTypeId: z.string().uuid(), qty: z.number().int().positive() });
export const reserveRoute = async (req,res)=>{
  const parse = ReserveSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({error: parse.error.errors});
  const { ticketTypeId, qty } = parse.data;

  const lockKey = `lock:${ticketTypeId}`;
  const lock = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  if (!lock) return res.status(409).json({error:'busy, retry'});
  try {
    const { rows } = await pool.query('select event_id,total_qty, sold_qty from ticket_types where id=$1', [ticketTypeId]);
    if (!rows.length) return res.status(404).json({error:'ticket type not found'});
    const eventId = rows[0].event_id;
    const available = rows[0].total_qty - rows[0].sold_qty;
    if (available < qty) return res.status(409).json({error:'not enough inventory'});

    const reservationId = uuid();
    const ttlSec = 300;
    await redis.set(`reservation:${reservationId}`, JSON.stringify({ ticketTypeId, qty }), 'EX', ttlSec);

    await pool.query(
      `insert into reservations
        (id, event_id, ticket_type_id, user_id, qty, expires_at, status)
      values
        ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, $7)`,
      [reservationId, eventId, ticketTypeId, 'buyer', qty, ttlSec, 'HELD']
    );

    res.json({ reservationId, expiresInSeconds: ttlSec });
  } finally {
    await redis.del(lockKey);
  }
};

export const commitReservation = async (reservationId) => {
  if (!reservationId) return { ok: false, reason: 'missing_id' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT r.id, r.ticket_type_id, r.qty, r.status, r.event_id,
              tt.total_qty, tt.sold_qty
       FROM reservations r
       JOIN ticket_types tt ON tt.id = r.ticket_type_id
       WHERE r.id = $1
       FOR UPDATE`,
      [reservationId]
    );

    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }

    const row = r.rows[0];

    if (String(row.status).toUpperCase() !== 'HELD') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'bad_status' };
    }

    // Confirm Redis still has the reservation (not expired)
    const redisVal = await redis.get(`reservation:${reservationId}`);
    if (!redisVal) {
      // mark expired in DB (only if still HELD)
      await client.query(
        `UPDATE reservations SET status = 'EXPIRED' WHERE id = $1 AND status = 'HELD'`,
        [reservationId]
      );
      await client.query('COMMIT');
      return { ok: false, reason: 'expired' };
    }

    const qty = Number(row.qty || 0);
    const available = Number(row.total_qty || 0) - Number(row.sold_qty || 0);
    if (available < qty) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient' };
    }

    // update sold_qty
    await client.query(
      `UPDATE ticket_types
       SET sold_qty = sold_qty + $1
       WHERE id = $2`,
      [qty, row.ticket_type_id]
    );

    // mark reservation committed and set committed_at
    await client.query(
      `UPDATE reservations
       SET status = 'COMMITTED', committed_at = now()
       WHERE id = $1`,
      [reservationId]
    );

    const payload = {
      type: 'reservation.committed',
      reservationId,
      eventId: row.event_id,
      ticketTypeId: row.ticket_type_id,
      qty,
      committed_at: new Date().toISOString()
    };

    const outboxId = uuid();
    await client.query(
      `INSERT INTO outbox (id, aggregate, payload_json, status, created_at)
       VALUES ($1, $2, $3::jsonb, 'pending', now())`,
      [outboxId, 'reservation', JSON.stringify(payload)]
    );

    await client.query('COMMIT');

    // remove the redis reservation (best-effort after commit)
    try { await redis.del(`reservation:${reservationId}`); } catch (e) { /* ignore */ }

    return { ok: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('commitReservation error:', err);
    return { ok: false, reason: 'error', detail: err.message };
  } finally {
    client.release();
  }
};

// ---------- existing: list ticket types for event ----------
export const ticketTypesRoute = async (req, res) => {
  const { eventId } = req.query || {};
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  const { rows } = await pool.query(
    `select id, name, price_cents, currency, total_qty, sold_qty
       from ticket_types where event_id = $1 order by name asc`,
    [eventId]
  );
  res.json(rows);
};

// ---------- NEW: create ticket type ----------
const CreateType = z.object({
  event_id: z.string().uuid(),
  name: z.string().min(1),
  price_cents: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
  total_qty: z.number().int().positive()
});
export const createTicketTypeRoute = async (req,res) => {
  const r = CreateType.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: r.error.errors });
  const id = uuid();
  const { event_id, name, price_cents, currency, total_qty } = r.data;
  await pool.query(
    `insert into ticket_types(id,event_id,name,price_cents,currency,total_qty,sold_qty)
     values($1,$2,$3,$4,$5,$6,0)`,
    [id, event_id, name, price_cents, currency.toUpperCase(), total_qty]
  );
  res.status(201).json({ id, event_id, name, price_cents, currency: currency.toUpperCase(), total_qty, sold_qty: 0 });
};

// ---------- NEW: list reservations (optionally by event) ----------
export const listReservationsRoute = async (req, res) => {
  try {
    const { eventId } = req.query || {};
    const sqlBase = `
      select
        r.id,
        r.event_id,
        e.name as event_name,
        coalesce(r.committed_at, r.created_at) as booked_at,  -- NEW
        r.qty,
        r.status,
        tt.name as ticket_type
      from reservations r
      join events e on e.id = r.event_id
      left join ticket_types tt on tt.id = r.ticket_type_id
    `;
    const order = ` order by booked_at desc nulls last`;
    const args = [];
    const sql = eventId ? sqlBase + ` where r.event_id = $1` + order : sqlBase + order;
    if (eventId) args.push(eventId);
    const { rows } = await pool.query(sql, args);
    res.json(rows);
  } catch (err) {
    console.error('reservations list failed:', err);
    res.status(500).json({ error: 'failed to load reservations' });
  }
};


// Update event
const UpdateEvent = z.object({
  name: z.string().min(2),
  venue: z.string().min(1),
  start_time: z.string(), 
  end_time: z.string()
});
export const updateEventRoute = async (req,res) => {
  const { id } = req.params;
  const r = UpdateEvent.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: r.error.errors });
  const { name, venue, start_time, end_time } = r.data;
  const { rowCount } = await pool.query(
    `update events set name=$1, venue=$2, start_time=$3, end_time=$4 where id=$5`,
    [name, venue, start_time, end_time, id]
  );
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ id, name, venue, start_time, end_time, updated: true });
};

export const deleteEventRoute = async (req,res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from reservations where event_id = $1`, [id]);
    await client.query(`delete from ticket_types where event_id = $1`, [id]);
    const r = await client.query(`delete from events where id = $1`, [id]);
    await client.query('commit');
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ id, deleted: true });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

export const eventStatsRoute = async (_req, res) => {
  const { rows } = await pool.query(`
    select
      e.id,
      e.name,
      e.venue,
      e.start_time,
      coalesce(sum(tt.sold_qty), 0) as sold_total,
      coalesce(
        json_agg(
          json_build_object('name', tt.name, 'sold', tt.sold_qty)
          order by tt.name
        ) filter (where tt.id is not null),
        '[]'::json
      ) as by_type
    from events e
    left join ticket_types tt on tt.event_id = e.id
    group by e.id
    order by e.start_time
  `);
  res.json(rows);
};
