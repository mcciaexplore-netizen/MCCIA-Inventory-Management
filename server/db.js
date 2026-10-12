import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const db = new DatabaseSync(process.env.DB_PATH || fileURLToPath(new URL('./inventory.db', import.meta.url)));
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff'
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT UNIQUE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 0, min_quantity INTEGER NOT NULL DEFAULT 0,
  location TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL, issued_to TEXT NOT NULL, department TEXT,
  issued_by INTEGER REFERENCES users(id), issued_at TEXT DEFAULT CURRENT_TIMESTAMP, returned_at TEXT
);
`);

// Lightweight migrations for columns added after the first release
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('items', 'unit', 'TEXT');
addColumn('items', 'rate', 'REAL');
addColumn('items', 'vendor', 'TEXT');
addColumn('issues', 'event', 'TEXT');
addColumn('issues', 'consumed', 'INTEGER NOT NULL DEFAULT 0');
export const OFFICES = ['Head Office', 'Bhosari', 'Tilak Road', 'Hadapsar', 'Ahmednagar'];
addColumn('users', 'office', "TEXT NOT NULL DEFAULT 'Head Office'");

db.exec(`
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL, rate REAL NOT NULL, challan_no TEXT, vendor TEXT,
  purchased_at TEXT NOT NULL, created_by INTEGER
);
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL, reason TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id INTEGER, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS closed_months (month TEXT PRIMARY KEY, closed_at TEXT NOT NULL, closed_by INTEGER);
CREATE TABLE IF NOT EXISTS month_closings (
  month TEXT NOT NULL, item_id INTEGER, name TEXT NOT NULL, vendor TEXT NOT NULL, category TEXT NOT NULL, unit TEXT,
  rate REAL NOT NULL DEFAULT 0, opening INTEGER NOT NULL DEFAULT 0, challan TEXT,
  purchased INTEGER NOT NULL DEFAULT 0, purchase_amount REAL NOT NULL DEFAULT 0,
  adjusted INTEGER NOT NULL DEFAULT 0, issued INTEGER NOT NULL DEFAULT 0, closing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_closings_month ON month_closings(month);
`);

// Local-time "YYYY-MM-DD HH:MM:SS", so month boundaries follow the office clock, not UTC.
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// SKU = 3-letter category prefix + running number per prefix, e.g. STA-0001. Items without a category use GEN.
export function nextSku(categoryId) {
  const cat = categoryId ? db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId) : null;
  const prefix = ((cat?.name || 'GEN').replace(/[^A-Za-z]/g, '').slice(0, 3) || 'GEN').toUpperCase();
  let max = 0;
  for (const r of db.prepare('SELECT sku FROM items WHERE sku LIKE ?').all(`${prefix}-%`)) {
    const n = Number(r.sku.slice(prefix.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

// Give every item that has no SKU one, oldest first.
for (const it of db.prepare(`SELECT id, category_id FROM items WHERE sku IS NULL OR sku = '' ORDER BY id`).all())
  db.prepare('UPDATE items SET sku=? WHERE id=?').run(nextSku(it.category_id), it.id);

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

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
    .run('Administrator', 'admin@mccia.local', hashPassword('admin123'), 'admin');
  for (const c of ['IT Equipment', 'Furniture', 'Stationery', 'Housekeeping', 'Audio/Visual', 'Other'])
    db.prepare('INSERT INTO categories (name) VALUES (?)').run(c);
  console.log('Seeded admin user: admin@mccia.local / admin123 (change it!)');
}
