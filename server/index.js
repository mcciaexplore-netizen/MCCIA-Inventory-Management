import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, hashPassword, verifyPassword, stamp, nextSku, OFFICES } from './db.js';
import { consumption, reorder, trend } from './insights.js';
import { MONTH_RE, buildReport, closeMonth, listMonths, reportWorkbook } from './reports.js';

const app = express();
app.use(express.json());

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new HttpError(message, status); };

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (res.headersSent) return res.end();
    const unique = String(e.message).includes('UNIQUE');
    res.status(e.status || (unique ? 409 : 500)).json({ error: unique ? 'Already exists' : e.message });
  }
};
const bad = (res, error, code = 400) => res.status(code).json({ error });
const int = (v) => Number.parseInt(v, 10);
const today = () => stamp().slice(0, 10);

function tx(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function audit(req, action, entity, entityId, detail) {
  db.prepare('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,detail,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.user?.id ?? null, req.user?.name ?? null, action, entity, entityId ?? null, detail ?? null, stamp());
}
// Closed months are frozen: no stock movements may be dated inside one.
function assertOpen(date) {
  const month = String(date).slice(0, 7);
  if (db.prepare('SELECT 1 FROM closed_months WHERE month=?').get(month)) fail(`${month} is closed; entries can't be added to it`);
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = token && db.prepare('SELECT u.id,u.name,u.email,u.role,u.office FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(token);
  if (!user) return bad(res, 'Unauthorized', 401);
  req.user = user; req.token = token; next();
}
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : bad(res, 'Admin only', 403));

app.get('/api/offices', wrap((req, res) => res.json(OFFICES)));
app.post('/api/login', wrap((req, res) => {
  const { email = '', password = '', office = '' } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) return bad(res, 'Invalid email or password', 401);
  if (u.office.toLowerCase() !== String(office).trim().toLowerCase()) return bad(res, 'You are not registered at the selected office', 401);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(token, u.id);
  res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, office: u.office } });
}));

app.use('/api', auth);
app.get('/api/me', (req, res) => res.json(req.user));
app.post('/api/logout', wrap((req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(req.token); res.json({ ok: true }); }));
app.post('/api/me/password', wrap((req, res) => {
  const { current_password = '', new_password = '' } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(current_password, u.password_hash)) return bad(res, 'Current password is incorrect');
  if (new_password.length < 6) return bad(res, 'New password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(new_password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, req.token);
  audit(req, 'password_change', 'user', u.id, u.email);
  res.json({ ok: true });
}));

app.get('/api/dashboard', wrap((req, res) => {
  const one = (q) => db.prepare(q).get();
  res.json({
    totalItems: one('SELECT COUNT(*) n FROM items').n,
    totalUnits: one('SELECT COALESCE(SUM(quantity),0) n FROM items').n,
    stockValue: Math.round(one('SELECT COALESCE(SUM(quantity*COALESCE(rate,0)),0) n FROM items').n),
    lowStock: db.prepare('SELECT i.*,c.name category FROM items i LEFT JOIN categories c ON c.id=i.category_id WHERE i.quantity <= i.min_quantity AND i.min_quantity > 0 ORDER BY i.quantity').all(),
    activeIssues: one('SELECT COUNT(*) n FROM issues WHERE returned_at IS NULL').n,
    categories: one('SELECT COUNT(*) n FROM categories').n,
    stockByVendor: db.prepare("SELECT COALESCE(vendor,'In-house') label, ROUND(SUM(quantity*COALESCE(rate,0))) value FROM items GROUP BY label HAVING value > 0 ORDER BY value DESC").all(),
    stockByCategory: db.prepare("SELECT COALESCE(c.name,'Uncategorised') label, ROUND(SUM(i.quantity*COALESCE(i.rate,0))) value FROM items i LEFT JOIN categories c ON c.id=i.category_id GROUP BY label HAVING value > 0 ORDER BY value DESC").all(),
    recent: db.prepare('SELECT s.*,i.name item_name FROM issues s JOIN items i ON i.id=s.item_id ORDER BY s.id DESC LIMIT 6').all(),
  });
}));

// Categories
app.get('/api/categories', wrap((req, res) => res.json(db.prepare('SELECT c.*,(SELECT COUNT(*) FROM items WHERE category_id=c.id) item_count FROM categories c ORDER BY name').all())));
app.post('/api/categories', admin, wrap((req, res) => {
  const name = (req.body.name || '').trim(); if (!name) return bad(res, 'Name required');
  const id = Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid);
  audit(req, 'create', 'category', id, name);
  res.status(201).json({ id, name });
}));
app.delete('/api/categories/:id', admin, wrap((req, res) => {
  const c = db.prepare('SELECT name FROM categories WHERE id=?').get(int(req.params.id));
  db.prepare('DELETE FROM categories WHERE id=?').run(int(req.params.id));
  audit(req, 'delete', 'category', int(req.params.id), c?.name);
  res.json({ ok: true });
}));

// Items
const ITEM_SQL = 'SELECT i.*,c.name category FROM items i LEFT JOIN categories c ON c.id=i.category_id';
app.get('/api/items', wrap((req, res) => res.json(db.prepare(`${ITEM_SQL} ORDER BY i.name`).all())));
function itemFields(b) {
  const name = (b.name || '').trim();
  const quantity = int(b.quantity), min = int(b.min_quantity || 0);
  if (!name) return 'Name required';
  if (!(quantity >= 0) || !(min >= 0)) return 'Quantities must be 0 or more';
  const rate = b.rate === '' || b.rate == null ? null : Number(b.rate);
  if (rate !== null && !(rate >= 0)) return 'Rate must be 0 or more';
  return { name, sku: (b.sku || '').trim() || null, category_id: b.category_id ? int(b.category_id) : null, quantity, min_quantity: min, location: b.location || null, notes: b.notes || null, unit: (b.unit || '').trim() || null, rate, vendor: (b.vendor || '').trim() || null };
}
app.post('/api/items', admin, wrap((req, res) => {
  const f = itemFields(req.body); if (typeof f === 'string') return bad(res, f);
  f.sku = f.sku || nextSku(f.category_id);
  const r = db.prepare('INSERT INTO items (name,sku,category_id,quantity,min_quantity,location,notes,unit,rate,vendor) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(f.name, f.sku, f.category_id, f.quantity, f.min_quantity, f.location, f.notes, f.unit, f.rate, f.vendor);
  audit(req, 'create', 'item', Number(r.lastInsertRowid), `${f.name} [${f.sku}] (opening qty ${f.quantity})`);
  res.status(201).json(db.prepare(`${ITEM_SQL} WHERE i.id=?`).get(r.lastInsertRowid));
}));
app.put('/api/items/:id', admin, wrap((req, res) => {
  const id = int(req.params.id);
  const f = itemFields(req.body); if (typeof f === 'string') return bad(res, f);
  const old = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!old) return bad(res, 'Item not found', 404);
  f.sku = f.sku || old.sku || nextSku(f.category_id);
  const delta = f.quantity - old.quantity;
  if (delta) assertOpen(today());
  tx(() => {
    db.prepare('UPDATE items SET name=?,sku=?,category_id=?,quantity=?,min_quantity=?,location=?,notes=?,unit=?,rate=?,vendor=? WHERE id=?')
      .run(f.name, f.sku, f.category_id, f.quantity, f.min_quantity, f.location, f.notes, f.unit, f.rate, f.vendor, id);
    // Quantity edits are recorded as adjustments so month reports stay reconcilable.
    if (delta) db.prepare('INSERT INTO adjustments (item_id,delta,reason,note,created_by,created_at) VALUES (?,?,?,?,?,?)').run(id, delta, 'Edited item', null, req.user.id, stamp());
  });
  const changed = ['name', 'sku', 'category_id', 'quantity', 'min_quantity', 'location', 'unit', 'rate', 'vendor'].filter((k) => (old[k] ?? null) !== (f[k] ?? null)).map((k) => `${k}: ${old[k] ?? '-'} → ${f[k] ?? '-'}`);
  audit(req, 'update', 'item', id, `${old.name}: ${changed.join('; ') || 'no field changes'}`);
  res.json(db.prepare(`${ITEM_SQL} WHERE i.id=?`).get(id));
}));
app.delete('/api/items/:id', admin, wrap((req, res) => {
  const old = db.prepare('SELECT name,quantity FROM items WHERE id=?').get(int(req.params.id));
  db.prepare('DELETE FROM items WHERE id=?').run(int(req.params.id));
  audit(req, 'delete', 'item', int(req.params.id), old ? `${old.name} (qty ${old.quantity})` : null);
  res.json({ ok: true });
}));

const REASONS = ['Damage', 'Loss', 'Recount', 'Expired', 'Other'];
app.post('/api/items/:id/adjust', admin, wrap((req, res) => {
  const id = int(req.params.id), delta = int(req.body.delta), reason = req.body.reason;
  if (!Number.isInteger(delta) || delta === 0) return bad(res, 'Enter a non-zero adjustment');
  if (!REASONS.includes(reason)) return bad(res, 'Choose a reason');
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!item) return bad(res, 'Item not found', 404);
  if (item.quantity + delta < 0) return bad(res, `Only ${item.quantity} in stock`);
  assertOpen(today());
  tx(() => {
    db.prepare('UPDATE items SET quantity=quantity+? WHERE id=?').run(delta, id);
    db.prepare('INSERT INTO adjustments (item_id,delta,reason,note,created_by,created_at) VALUES (?,?,?,?,?,?)').run(id, delta, reason, req.body.note || null, req.user.id, stamp());
  });
  audit(req, 'adjust', 'item', id, `${item.name}: ${delta > 0 ? '+' : ''}${delta} (${reason})${req.body.note ? ' - ' + req.body.note : ''}`);
  res.json({ ok: true });
}));

// Purchases (stock in)
app.get('/api/purchases', wrap((req, res) => res.json(db.prepare(
  'SELECT p.*,i.name item_name,i.unit FROM purchases p JOIN items i ON i.id=p.item_id ORDER BY p.purchased_at DESC, p.id DESC').all())));
app.post('/api/purchases', admin, wrap((req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity), rate = Number(req.body.rate);
  const date = req.body.purchased_at || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'Invalid date');
  if (date > today()) return bad(res, "Date can't be in the future");
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  if (!(rate >= 0)) return bad(res, 'Rate must be 0 or more');
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!item) return bad(res, 'Item not found', 404);
  assertOpen(date);
  const vendor = (req.body.vendor || '').trim() || item.vendor || null;
  const challan = (req.body.challan_no || '').trim() || null;
  tx(() => {
    db.prepare('INSERT INTO purchases (item_id,quantity,rate,challan_no,vendor,purchased_at,created_by) VALUES (?,?,?,?,?,?,?)').run(itemId, qty, rate, challan, vendor, date, req.user.id);
    // The item's current rate follows its latest purchase, as in the paper register.
    db.prepare('UPDATE items SET quantity=quantity+?, rate=?, vendor=COALESCE(vendor,?) WHERE id=?').run(qty, rate, vendor, itemId);
  });
  audit(req, 'purchase', 'item', itemId, `${item.name}: +${qty} @ ${rate}${challan ? ` (challan ${challan})` : ''}`);
  res.status(201).json({ ok: true });
}));

// Issues
app.get('/api/issues', wrap((req, res) => res.json(db.prepare(
  'SELECT s.*,i.name item_name,u.name issued_by_name FROM issues s JOIN items i ON i.id=s.item_id LEFT JOIN users u ON u.id=s.issued_by ORDER BY s.issued_at DESC, s.id DESC').all())));
app.post('/api/issues', wrap((req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity), to = (req.body.issued_to || '').trim();
  if (!to) return bad(res, 'Issued-to is required');
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!item) return bad(res, 'Item not found', 404);
  if (item.quantity < qty) return bad(res, `Only ${item.quantity} in stock`);
  assertOpen(today());
  tx(() => {
    db.prepare('UPDATE items SET quantity=quantity-? WHERE id=?').run(qty, itemId);
    db.prepare('INSERT INTO issues (item_id,quantity,issued_to,department,event,issued_by,issued_at) VALUES (?,?,?,?,?,?,?)').run(itemId, qty, to, req.body.department || null, req.body.event || null, req.user.id, stamp());
  });
  audit(req, 'issue', 'item', itemId, `${qty} × ${item.name} → ${to}`);
  res.status(201).json({ ok: true });
}));

// Daily entry: several consumed items for one person/event in one go.
app.post('/api/issues/batch', wrap((req, res) => {
  const { date = today(), issued_to = '', event = '', department = '', lines = [] } = req.body;
  const to = issued_to.trim();
  if (!to) return bad(res, 'Person name is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'Invalid date');
  if (date > today()) return bad(res, "Date can't be in the future");
  assertOpen(date);
  const need = new Map();
  for (const l of lines) {
    const id = int(l.item_id), q = int(l.quantity);
    if (!id && !l.quantity) continue;
    if (!id || !(q > 0)) return bad(res, 'Each line needs an item and a quantity of at least 1');
    need.set(id, (need.get(id) || 0) + q);
  }
  if (!need.size) return bad(res, 'Add at least one item');
  const items = new Map();
  for (const [id, q] of need) {
    const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!it) return bad(res, 'Item not found', 404);
    if (it.quantity < q) return bad(res, `${it.name}: only ${it.quantity} in stock`);
    items.set(id, it);
  }
  const when = `${date} 00:00:00`;
  tx(() => {
    for (const [id, q] of need) {
      db.prepare('UPDATE items SET quantity=quantity-? WHERE id=?').run(q, id);
      db.prepare('INSERT INTO issues (item_id,quantity,issued_to,department,event,issued_by,issued_at,returned_at,consumed) VALUES (?,?,?,?,?,?,?,?,1)')
        .run(id, q, to, department || null, event || null, req.user.id, when, when);
    }
  });
  audit(req, 'consume', 'issue', null, `${date} ${to}${event ? ` (${event})` : ''}: ${[...need].map(([id, q]) => `${q} × ${items.get(id).name}`).join(', ')}`);
  res.status(201).json({ ok: true, count: need.size });
}));
app.post('/api/issues/:id/return', wrap((req, res) => {
  const iss = db.prepare('SELECT s.*,i.name item_name FROM issues s JOIN items i ON i.id=s.item_id WHERE s.id=?').get(int(req.params.id));
  if (!iss) return bad(res, 'Not found', 404);
  if (iss.consumed) return bad(res, 'Consumed items cannot be returned');
  if (iss.returned_at) return bad(res, 'Already returned');
  assertOpen(today());
  tx(() => {
    db.prepare('UPDATE issues SET returned_at=? WHERE id=?').run(stamp(), iss.id);
    db.prepare('UPDATE items SET quantity=quantity+? WHERE id=?').run(iss.quantity, iss.item_id);
  });
  audit(req, 'return', 'item', iss.item_id, `${iss.quantity} × ${iss.item_name} from ${iss.issued_to}`);
  res.json({ ok: true });
}));

// Monthly register
app.get('/api/reports/months', wrap((req, res) => res.json(listMonths())));
const monthParam = (req) => { if (!MONTH_RE.test(req.params.month)) fail('Invalid month'); return req.params.month; };
app.get('/api/reports/:month', wrap((req, res) => res.json(buildReport(monthParam(req)))));
app.get('/api/reports/:month/export', wrap(async (req, res) => {
  const month = monthParam(req);
  const wb = await reportWorkbook(month);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="MCCIA-Stock-Register-${month}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));
app.post('/api/reports/:month/close', admin, wrap((req, res) => {
  const month = monthParam(req);
  if (month > today().slice(0, 7)) return bad(res, "Can't close a future month");
  if (db.prepare('SELECT 1 FROM closed_months WHERE month=?').get(month)) return bad(res, 'Already closed');
  const n = closeMonth(month, req.user.id);
  audit(req, 'close_month', 'month', null, `${month}: ${n} items frozen`);
  res.json({ ok: true });
}));
app.delete('/api/reports/:month/close', admin, wrap((req, res) => {
  const month = monthParam(req);
  const c = db.prepare('SELECT * FROM closed_months WHERE month=?').get(month);
  if (!c) return bad(res, 'Month is not closed');
  if (c.closed_by == null) return bad(res, 'Imported months cannot be reopened');
  if (db.prepare('SELECT 1 FROM closed_months WHERE month>?').get(month)) return bad(res, 'Reopen later months first');
  tx(() => { db.prepare('DELETE FROM month_closings WHERE month=?').run(month); db.prepare('DELETE FROM closed_months WHERE month=?').run(month); });
  audit(req, 'reopen_month', 'month', null, month);
  res.json({ ok: true });
}));

// Insights
app.get('/api/insights', wrap((req, res) => {
  const m = req.query.month || 'all';
  if (m !== 'all' && !MONTH_RE.test(m)) return bad(res, 'Invalid month');
  res.json({ ...consumption(m), trend: trend() });
}));
app.get('/api/insights/reorder', wrap((req, res) => res.json(reorder())));

// Audit log
app.get('/api/audit', admin, wrap((req, res) => {
  const entity = req.query.entity;
  const rows = entity
    ? db.prepare('SELECT * FROM audit_log WHERE entity=? ORDER BY id DESC LIMIT 300').all(entity)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all();
  res.json(rows);
}));

// Users
app.get('/api/users', admin, wrap((req, res) => res.json(db.prepare('SELECT id,name,email,role,office FROM users ORDER BY name').all())));
app.post('/api/users', admin, wrap((req, res) => {
  const { name = '', email = '', password = '', role = 'staff', office = '' } = req.body;
  if (!name.trim() || !email.trim() || password.length < 6) return bad(res, 'Name, email and a 6+ character password are required');
  if (!['admin', 'staff'].includes(role)) return bad(res, 'Invalid role');
  if (!OFFICES.includes(office.trim())) return bad(res, 'Choose a valid office');
  const r = db.prepare('INSERT INTO users (name,email,password_hash,role,office) VALUES (?,?,?,?,?)').run(name.trim(), email.trim().toLowerCase(), hashPassword(password), role, office.trim());
  audit(req, 'create', 'user', Number(r.lastInsertRowid), `${email.trim().toLowerCase()} (${role}, ${office.trim()})`);
  res.status(201).json({ ok: true });
}));
app.post('/api/users/:id/password', admin, wrap((req, res) => {
  const id = int(req.params.id), password = req.body.password || '';
  if (password.length < 6) return bad(res, 'Password must be at least 6 characters');
  const u = db.prepare('SELECT email FROM users WHERE id=?').get(id);
  if (!u) return bad(res, 'User not found', 404);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(req, 'password_reset', 'user', id, u.email);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', admin, wrap((req, res) => {
  const id = int(req.params.id);
  if (id === req.user.id) return bad(res, "You can't delete yourself");
  const u = db.prepare('SELECT email FROM users WHERE id=?').get(id);
  // Keep history: issues reference the user, so detach rather than fail the delete.
  tx(() => {
    db.prepare('UPDATE issues SET issued_by=NULL WHERE issued_by=?').run(id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
  });
  audit(req, 'delete', 'user', id, u?.email);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => bad(res, `No such endpoint: ${req.method} ${req.originalUrl}`, 404));

// Serve built client in production
const dist = fileURLToPath(new URL('../client/dist', import.meta.url));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(dist + '/index.html'));
}
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API on http://localhost:${port}`));
