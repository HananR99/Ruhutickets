import express from 'express';

const router = express.Router();

const INVENTORY_HOST = process.env.INVENTORY_HOST || 'http://inventory:8080';

// Health
router.get('/health', (_req, res) => {
  res.json({ service: 'payment', ok: true });
});

/**
 * POST /webhooks/payment/charge
 * body: { reservationId: string }
 * 200 -> { ok:true, message, reservation:{ id, event_name, start_time, ticket_type, qty, status } }
 * 409 -> { ok:false, error: 'expired' | ... }
 */
router.post('/webhooks/payment/charge', async (req, res) => {
  try {
    const { reservationId } = req.body || {};
    if (!reservationId) return res.status(400).json({ error: 'reservationId required' });

    // Fake charge (success). 

    // Finalize with Inventory
    const r = await fetch(`${INVENTORY_HOST}/inventory/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservationId })
  });


    const data = await r.json().catch(() => ({}));

    if (!r.ok || data?.ok === false) {
      // Inventory said expired or failed
      return res.status(409).json({ ok: false, error: data?.error || 'commit failed' });
    }

    // Pass through rich confirmation for the UI
    return res.json({
      ok: true,
      message: data?.message || 'payment authorized & inventory committed',
      reservation: data?.reservation ?? null,
    });
  } catch (err) {
    console.error('charge failed:', err);
    return res.status(500).json({ error: 'charge failed' });
  }
});

export default router;
