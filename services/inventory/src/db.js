import pg from 'pg';
export const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: +(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'ruhu'
});
export async function migrate() {
  await pool.query(`
  create table if not exists events(
    id uuid primary key,
    name text not null,
    venue text,
    start_time timestamptz,
    end_time timestamptz
  );
  create table if not exists ticket_types(
    id uuid primary key,
    event_id uuid references events(id),
    name text not null,
    price_cents int not null,
    currency text not null,
    total_qty int not null,
    sold_qty int not null default 0
  );
  create table if not exists reservations(
    id uuid primary key,
    event_id uuid references events(id),
    seat_no text,
    user_id text,
    expires_at timestamptz,
    status text not null
  );
  create table if not exists orders(
    id uuid primary key,
    user_id text,
    total_cents int not null,
    currency text not null,
    status text not null,
    created_at timestamptz default now()
  );
  create table if not exists order_items(
    id uuid primary key,
    order_id uuid references orders(id),
    ticket_type_id uuid references ticket_types(id),
    seat_no text,
    qty int not null,
    price_cents int not null
  );
  create table if not exists outbox(
    id uuid primary key,
    aggregate text,
    payload_json jsonb,
    status text,
    created_at timestamptz default now()
  );
  `);

    await pool.query(`
    ALTER TABLE IF EXISTS reservations
      ADD COLUMN IF NOT EXISTS ticket_type_id uuid REFERENCES ticket_types(id);
    ALTER TABLE IF EXISTS reservations
      ADD COLUMN IF NOT EXISTS qty int NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS reservations
      ADD COLUMN IF NOT EXISTS committed_at timestamptz;
  `);
}
