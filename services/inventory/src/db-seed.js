import { pool, migrate } from './db.js';
import { randomUUID } from 'crypto';

async function seed() {
  await migrate();

  const eventId = randomUUID();
  await pool.query(
    `insert into events(id,name,venue,start_time,end_time)
     values($1,$2,$3, now() + interval '7 day', now() + interval '7 day' + interval '3 hour')
     on conflict (id) do nothing`,
    [eventId, 'Concert A', 'Ruhuna Arena']
  );

  const vipId = randomUUID();
  const genId = randomUUID();

  await pool.query(
    `insert into ticket_types(id,event_id,name,price_cents,currency,total_qty,sold_qty)
     values($1,$2,'VIP',150000,'LKR',50,0)
     on conflict (id) do nothing`,
    [vipId, eventId]
  );

  await pool.query(
    `insert into ticket_types(id,event_id,name,price_cents,currency,total_qty,sold_qty)
     values($1,$2,'General',50000,'LKR',150,0)
     on conflict (id) do nothing`,
    [genId, eventId]
  );

  console.log('Seeded event:', eventId);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then(() => {
    console.log('Seed complete');
    process.exit(0);
  }).catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}

export { seed }; 
