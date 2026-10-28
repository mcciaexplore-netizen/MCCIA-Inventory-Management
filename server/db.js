import pg from 'pg';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// COUNT/SUM come back as bigint (string) by default; our values are small enough for Number.
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

// Without DATABASE_URL, fall back to an embedded Postgres (PGlite) stored in server/.pgdata with sample data.
// Handy for local trials; use Neon (DATABASE_URL) for anything real.
const EMBEDDED = !process.env.DATABASE_URL;
let pool;
if (EMBEDDED) {
  const { PGlite } = await import('@electric-sql/pglite');
  // PGLITE_DIR=:memory: gives each process (e.g. a test run) its own throwaway in-memory database.
  const dataDir = process.env.PGLITE_DIR === ':memory:' ? undefined : (process.env.PGLITE_DIR || fileURLToPath(new URL('./.pgdata', import.meta.url)));
  const lite = await PGlite.create(dataDir);
  const opts = { parsers: { 20: Number, 1700: Number } };
  const raw = async (sql, params) => (params?.length ? lite.query(sql, params, opts) : (await lite.exec(sql, opts)).at(-1));
  // PGlite is a single connection, so a transaction must hold it exclusively: otherwise another
  // request's queries would run inside (and commit or roll back with) that transaction.
  let tail = Promise.resolve();
  const acquire = () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const ready = tail.then(() => release);
    tail = tail.then(() => held);
    return ready;
  };
  pool = {
    query: async (sql, params) => { const release = await acquire(); try { return await raw(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query: raw, release }; },
  };
  console.log(`DATABASE_URL not set: using embedded sample database (${dataDir ? 'server/.pgdata' : 'in-memory'})`);
} else {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX) || 5 });
}

// Every executor (pool or transaction client) exposes the same helpers. Use `?` placeholders.
const numbered = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const executor = (c) => ({
  all: async (sql, params = []) => (await c.query(numbered(sql), params)).rows,
  get: async (sql, params = []) => (await c.query(numbered(sql), params)).rows[0],
  run: async (sql, params = []) => c.query(numbered(sql), params),
  // INSERT ... RETURNING id, returns the new id
  insert: async (sql, params = []) => (await c.query(`${numbered(sql)} RETURNING id`, params)).rows[0].id,
});
export const db = executor(pool);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(executor(c));
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

export const OFFICES = ['Head Office', 'Bhosari', 'Tilak Road', 'Hadapsar', 'Ahmednagar'];

// Timestamps are stored as "YYYY-MM-DD HH:MM:SS" text in office time (IST), so month boundaries
// follow the office clock regardless of the server's timezone.
const NOW_IST = `to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS')`;

await db.run(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', office TEXT NOT NULL DEFAULT 'Head Office'
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT DEFAULT ${NOW_IST});
CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 0, min_quantity INTEGER NOT NULL DEFAULT 0,
  location TEXT, notes TEXT, created_at TEXT DEFAULT ${NOW_IST},
  unit TEXT, rate DOUBLE PRECISION, vendor TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL, issued_to TEXT NOT NULL, department TEXT,
  issued_by INTEGER REFERENCES users(id), issued_at TEXT DEFAULT ${NOW_IST}, returned_at TEXT,
  event TEXT, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL, requested_at TEXT DEFAULT ${NOW_IST},
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, resolved_at TEXT, reject_reason TEXT,
  issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS queries (
  id SERIAL PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT DEFAULT ${NOW_IST},
  response TEXT, resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL, rate DOUBLE PRECISION NOT NULL, challan_no TEXT, vendor TEXT,
  purchased_at TEXT NOT NULL, created_by INTEGER
);
CREATE TABLE IF NOT EXISTS adjustments (
  id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL, reason TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY, user_id INTEGER, user_name TEXT, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id INTEGER, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS closed_months (month TEXT PRIMARY KEY, closed_at TEXT NOT NULL, closed_by INTEGER);
CREATE TABLE IF NOT EXISTS month_closings (
  month TEXT NOT NULL, item_id INTEGER, name TEXT NOT NULL, vendor TEXT NOT NULL, category TEXT NOT NULL, unit TEXT,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0, opening INTEGER NOT NULL DEFAULT 0, challan TEXT,
  purchased INTEGER NOT NULL DEFAULT 0, purchase_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  adjusted INTEGER NOT NULL DEFAULT 0, issued INTEGER NOT NULL DEFAULT 0, closing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_closings_month ON month_closings(month);
ALTER TABLE items DROP COLUMN IF EXISTS sku;
ALTER TABLE items ADD COLUMN IF NOT EXISTS vendor_email TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_ref TEXT;
CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY, po_no TEXT UNIQUE, vendor TEXT NOT NULL, vendor_email TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft', created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT ${NOW_IST}, sent_at TEXT, received_at TEXT
);
CREATE TABLE IF NOT EXISTS po_lines (
  id SERIAL PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, quantity INTEGER NOT NULL, rate DOUBLE PRECISION NOT NULL DEFAULT 0
);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_address TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_gstin TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_pan TEXT;
CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, email TEXT, address TEXT, gstin TEXT, pan TEXT,
  created_at TEXT DEFAULT ${NOW_IST}
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
-- Marks sessions created through Hub SSO (/api/sso/callback) rather than a password login.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sso BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS login_failures (email TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(email, at);

-- Service/maintenance complaints: an employee (or admin) raises one with a note and/or photo;
-- staff (or admin) close it out by attaching a photo of the fix.
CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id SERIAL PRIMARY KEY, note TEXT, photo_url TEXT, status TEXT NOT NULL DEFAULT 'open',
  raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL, raised_at TEXT DEFAULT ${NOW_IST},
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, resolved_at TEXT,
  resolution_note TEXT, resolution_photo_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_tickets(status);
CREATE INDEX IF NOT EXISTS idx_maintenance_raised_by ON maintenance_tickets(raised_by);

-- Postgres doesn't auto-index foreign keys; these back the joins/point-lookups index.js and
-- reports.js actually run (the item-delete stock-history check, staff's own requests/queries, audit filtering).
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_issues_item ON issues(item_id);
CREATE INDEX IF NOT EXISTS idx_purchases_item ON purchases(item_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_item ON adjustments(item_id);
CREATE INDEX IF NOT EXISTS idx_requests_item ON requests(item_id);
CREATE INDEX IF NOT EXISTS idx_requests_requested_by ON requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_queries_raised_by ON queries(raised_by);
CREATE INDEX IF NOT EXISTS idx_po_lines_item ON po_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_po_lines_po ON po_lines(po_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity);
`);

// "YYYY-MM-DD HH:MM:SS" in Asia/Kolkata
export function stamp(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// Fulfilled requests used to be recorded as open loans; mark them consumed. Reports are unaffected
// (an unreturned loan and a consumed issue both count as issued once).
await db.run(`UPDATE issues SET consumed=1, returned_at=issued_at
  WHERE consumed=0 AND returned_at IS NULL AND id IN (SELECT issue_id FROM requests WHERE status='fulfilled' AND issue_id IS NOT NULL)`);

// The 'manager' role was renamed to 'employee'; migrate any existing rows.
await db.run(`UPDATE users SET role='employee' WHERE role='manager'`);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

if (!(await db.get('SELECT 1 FROM users LIMIT 1'))) {
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  await db.run('INSERT INTO users (name,email,password_hash,role,must_change_password) VALUES (?,?,?,?,TRUE)',
    ['Administrator', 'admin@mccia.local', hashPassword(tempPassword), 'admin']);
  for (const c of ['IT Equipment', 'Furniture', 'Stationery', 'Housekeeping', 'Audio/Visual', 'Other'])
    await db.run('INSERT INTO categories (name) VALUES (?)', [c]);
  console.log(`Seeded admin user admin@mccia.local with one-time password: ${tempPassword} (must be changed at first login; shown only this once)`);
}

