import express from 'express';
import { pool } from './db.js';
import { commitReservation } from './routes.js';
import { publishNotification } from './amqp.js';

const router = express.Router();

/**
 * POST /inventory/commit
 * body: { reservationId }
 * returns: { ok, message, reservation: { id, event_name, start_time, ticket_type, qty, status } }
 */
router.post('/commit', async (req, res) => {
  try {
    const { reservationId } = req.body || {};
    if (!reservationId) return res.status(400).json({ error: 'reservationId required' });

    const result = await commitReservation(reservationId);
    if (!result.ok) {
      return res.status(409).json({ ok: false, error: result.reason || 'expired' });
    }

    const { rows } = await pool.query(
      `select
         r.id,
         r.qty,
         r.status,
         e.name as event_name,
         e.start_time,
         tt.name as ticket_type
       from reservations r
       join events e on e.id = r.event_id
       left join ticket_types tt on tt.id = r.ticket_type_id
       where r.id = $1`,
      [reservationId]
    );

        const reservation = rows[0] || null;

    if (reservation) {
      const notificationPayload = {
        type: 'reservation_committed',
        to: reservation.id,
        reservation: {
          id: reservation.id,
          event_name: reservation.event_name,
          event_start_time: reservation.start_time,
          ticket_type: reservation.ticket_type,
          ticket_type_id: reservation.ticket_type_id || null,
          qty: reservation.qty,
          status: reservation.status,
          committed_at: new Date().toISOString()
        },
        producedAt: new Date().toISOString()
      };

      publishNotification(notificationPayload)
        .then(ok => {
          if (ok) {
            console.log('[inventory] published reservation_committed', reservation.id);
          } else {
            console.warn('[inventory] publish returned false for', reservation.id);
          }
        })
        .catch(err => {
          console.error('[inventory] publishNotification error', err && err.message ? err.message : err);
        });
    }

    return res.json({
      ok: true,
      message: 'payment authorized & inventory committed',
      reservation: reservation
    });
  } catch (err) {
    console.error('commit failed:', err);
    res.status(500).json({ error: 'commit failed' });
  }
});

export default router;
