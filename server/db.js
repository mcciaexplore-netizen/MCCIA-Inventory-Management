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
  const lite = await PGlite.create(fileURLToPath(new URL('./.pgdata', import.meta.url)));
  const opts = { parsers: { 20: Number, 1700: Number } };
  const client = { query: async (sql, params) => (params?.length ? lite.query(sql, params, opts) : (await lite.exec(sql, opts)).at(-1)), release() {} };
  pool = { ...client, connect: async () => client };
  console.log('DATABASE_URL not set: using embedded sample database (server/.pgdata)');
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
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, sku TEXT UNIQUE,
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
`);

// "YYYY-MM-DD HH:MM:SS" in Asia/Kolkata
export function stamp(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// SKU = 3-letter category prefix + running number per prefix, e.g. STA-0001. Items without a category use GEN.
export async function nextSku(categoryId, ex = db) {
  const cat = categoryId ? await ex.get('SELECT name FROM categories WHERE id=?', [categoryId]) : null;
  const prefix = ((cat?.name || 'GEN').replace(/[^A-Za-z]/g, '').slice(0, 3) || 'GEN').toUpperCase();
  let max = 0;
  for (const r of await ex.all('SELECT sku FROM items WHERE sku LIKE ?', [`${prefix}-%`])) {
    const n = Number(r.sku.slice(prefix.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

// Give every item that has no SKU one, oldest first.
for (const it of await db.all(`SELECT id, category_id FROM items WHERE sku IS NULL OR sku = '' ORDER BY id`))
  await db.run('UPDATE items SET sku=? WHERE id=?', [await nextSku(it.category_id), it.id]);

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
  await db.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)',
    ['Administrator', 'admin@mccia.local', hashPassword('admin123'), 'admin']);
  for (const c of ['IT Equipment', 'Furniture', 'Stationery', 'Housekeeping', 'Audio/Visual', 'Other'])
    await db.run('INSERT INTO categories (name) VALUES (?)', [c]);
  console.log('Seeded admin user: admin@mccia.local / admin123 (change it!)');
}

if (EMBEDDED && !(await db.get('SELECT 1 FROM items LIMIT 1'))) {
  const cat = async (n) => (await db.get('SELECT id FROM categories WHERE name=?', [n])).id;
  const sample = [
    ['Natraj Pen', 'Stationery', 'Nos', 5, 120, 30, 'Natraj Stationers'], ['A4 Paper Ream', 'Stationery', 'Ream', 260, 40, 10, 'Natraj Stationers'],
    ['White Board Marker', 'Stationery', 'Nos', 18, 8, 10, 'Natraj Stationers'], ['HDMI Cable', 'IT Equipment', 'Nos', 350, 6, 2, 'Digital Hub'],
    ['Wireless Mouse', 'IT Equipment', 'Nos', 650, 3, 4, 'Digital Hub'], ['Phenyl 5L', 'Housekeeping', 'Can', 480, 12, 3, 'Clean Co'],
  ];
  for (const [name, c, unit, rate, quantity, min, vendor] of sample) {
    const id = await db.insert('INSERT INTO items (name,sku,category_id,quantity,min_quantity,unit,rate,vendor) VALUES (?,?,?,?,?,?,?,?)',
      [name, await nextSku(await cat(c)), await cat(c), quantity, min, unit, rate, vendor]);
    await db.run('INSERT INTO issues (item_id,quantity,issued_to,event,issued_at,returned_at,consumed) VALUES (?,?,?,?,?,?,1)', [id, 5, 'Front Desk', 'Daily use', stamp(), stamp()]);
  }
  console.log('Loaded sample items.');
}
