import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { db, tx, hashPassword, verifyPassword, stamp, nextSku, OFFICES } from './db.js';
import { consumption, reorder, trend } from './insights.js';
import { alertRecipients, lowStockEmail, mailReady, poEmail, sendMail } from './mail.js';
import { MONTH_RE, buildReport, closeMonth, listMonths, reportWorkbook } from './reports.js';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
app.use(express.json());

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new HttpError(message, status); };

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (res.headersSent) return res.end();
    const unique = e.code === '23505';
    res.status(e.status || (unique ? 409 : 500)).json({ error: unique ? 'Already exists' : e.message });
  }
};
const bad = (res, error, code = 400) => res.status(code).json({ error });
const int = (v) => Number.parseInt(v, 10);
const today = () => stamp().slice(0, 10);

const audit = (req, action, entity, entityId, detail) =>
  db.run('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,detail,created_at) VALUES (?,?,?,?,?,?,?)',
    [req.user?.id ?? null, req.user?.name ?? null, action, entity, entityId ?? null, detail ?? null, stamp()]);
// Closed months are frozen: no stock movements may be dated inside one.
async function assertOpen(date) {
  const month = String(date).slice(0, 7);
  if (await db.get('SELECT 1 FROM closed_months WHERE month=?', [month])) fail(`${month} is closed; entries can't be added to it`);
}

// Email the alert recipients when an item first drops to (or below) its minimum level.
async function notifyLow(itemId, before) {
  try {
    const it = await db.get('SELECT * FROM items WHERE id=?', [itemId]);
    if (!it || !(it.min_quantity > 0) || before <= it.min_quantity || it.quantity > it.min_quantity) return;
    const to = await alertRecipients();
    if (mailReady() && to.length) await sendMail({ to, subject: `Low stock: ${it.name} (${it.quantity} left)`, html: lowStockEmail(it) });
  } catch (e) { console.error('low-stock alert failed:', e.message); }
}

const auth = wrap(async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = token && await db.get('SELECT u.id,u.name,u.email,u.role,u.office FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', [token]);
  if (!user) return bad(res, 'Unauthorized', 401);
  req.user = user; req.token = token; next();
});
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : bad(res, 'Admin only', 403));
const manager = (req, res, next) => (['admin', 'manager'].includes(req.user.role) ? next() : bad(res, 'Manager or admin only', 403));

app.get('/api/offices', wrap((req, res) => res.json(OFFICES)));
app.post('/api/login', wrap(async (req, res) => {
  const { email = '', password = '', office = '' } = req.body;
  const u = await db.get('SELECT * FROM users WHERE email=?', [email.trim().toLowerCase()]);
  if (!u || !verifyPassword(password, u.password_hash)) return bad(res, 'Invalid email or password', 401);
  if (u.office.toLowerCase() !== String(office).trim().toLowerCase()) return bad(res, 'You are not registered at the selected office', 401);
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token,user_id) VALUES (?,?)', [token, u.id]);
  res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, office: u.office } });
}));

app.use('/api', auth);
app.get('/api/me', (req, res) => res.json(req.user));
app.post('/api/logout', wrap(async (req, res) => { await db.run('DELETE FROM sessions WHERE token=?', [req.token]); res.json({ ok: true }); }));
app.post('/api/me/password', wrap(async (req, res) => {
  const { current_password = '', new_password = '' } = req.body;
  const u = await db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!verifyPassword(current_password, u.password_hash)) return bad(res, 'Current password is incorrect');
  if (new_password.length < 6) return bad(res, 'New password must be at least 6 characters');
  await db.run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(new_password), u.id]);
  await db.run('DELETE FROM sessions WHERE user_id=? AND token<>?', [u.id, req.token]);
  await audit(req, 'password_change', 'user', u.id, u.email);
  res.json({ ok: true });
}));

app.get('/api/dashboard', wrap(async (req, res) => {
  const one = (q) => db.get(q);
  const [totalItems, totalUnits, stockValue, lowStock, activeIssues, categories, stockByVendor, stockByCategory, recent] = await Promise.all([
    one('SELECT COUNT(*) n FROM items'),
    one('SELECT COALESCE(SUM(quantity),0) n FROM items'),
    one('SELECT COALESCE(SUM(quantity*COALESCE(rate,0)),0) n FROM items'),
    db.all('SELECT i.*,c.name category FROM items i LEFT JOIN categories c ON c.id=i.category_id WHERE i.quantity <= i.min_quantity AND i.min_quantity > 0 ORDER BY i.quantity'),
    one('SELECT COUNT(*) n FROM issues WHERE returned_at IS NULL'),
    one('SELECT COUNT(*) n FROM categories'),
    db.all("SELECT COALESCE(vendor,'In-house') label, ROUND(SUM(quantity*COALESCE(rate,0))::numeric) value FROM items GROUP BY 1 HAVING SUM(quantity*COALESCE(rate,0)) > 0 ORDER BY 2 DESC"),
    db.all("SELECT COALESCE(c.name,'Uncategorised') label, ROUND(SUM(i.quantity*COALESCE(i.rate,0))::numeric) value FROM items i LEFT JOIN categories c ON c.id=i.category_id GROUP BY 1 HAVING SUM(i.quantity*COALESCE(i.rate,0)) > 0 ORDER BY 2 DESC"),
    db.all('SELECT s.*,i.name item_name FROM issues s JOIN items i ON i.id=s.item_id ORDER BY s.id DESC LIMIT 6'),
  ]);
  res.json({
    totalItems: totalItems.n, totalUnits: totalUnits.n, stockValue: Math.round(stockValue.n), lowStock,
    activeIssues: activeIssues.n, categories: categories.n, stockByVendor, stockByCategory, recent,
  });
}));

// Categories
app.get('/api/categories', wrap(async (req, res) => res.json(await db.all('SELECT c.*,(SELECT COUNT(*) FROM items WHERE category_id=c.id) item_count FROM categories c ORDER BY name'))));
app.post('/api/categories', admin, wrap(async (req, res) => {
  const name = (req.body.name || '').trim(); if (!name) return bad(res, 'Name required');
  const id = await db.insert('INSERT INTO categories (name) VALUES (?)', [name]);
  await audit(req, 'create', 'category', id, name);
  res.status(201).json({ id, name });
}));
app.delete('/api/categories/:id', admin, wrap(async (req, res) => {
  const c = await db.get('SELECT name FROM categories WHERE id=?', [int(req.params.id)]);
  await db.run('DELETE FROM categories WHERE id=?', [int(req.params.id)]);
  await audit(req, 'delete', 'category', int(req.params.id), c?.name);
  res.json({ ok: true });
}));

// Items
const ITEM_SQL = 'SELECT i.*,c.name category FROM items i LEFT JOIN categories c ON c.id=i.category_id';
app.get('/api/items', wrap(async (req, res) => res.json(await db.all(`${ITEM_SQL} ORDER BY i.name`))));
function itemFields(b) {
  const name = (b.name || '').trim();
  const quantity = int(b.quantity), min = int(b.min_quantity || 0);
  if (!name) return 'Name required';
  if (!(quantity >= 0) || !(min >= 0)) return 'Quantities must be 0 or more';
  const rate = b.rate === '' || b.rate == null ? null : Number(b.rate);
  if (rate !== null && !(rate >= 0)) return 'Rate must be 0 or more';
  return { name, sku: (b.sku || '').trim() || null, category_id: b.category_id ? int(b.category_id) : null, quantity, min_quantity: min, location: b.location || null, notes: b.notes || null, unit: (b.unit || '').trim() || null, rate, vendor: (b.vendor || '').trim() || null, vendor_email: (b.vendor_email || '').trim() || null };
}
app.post('/api/items', manager, wrap(async (req, res) => {
  const f = itemFields(req.body); if (typeof f === 'string') return bad(res, f);
  f.sku = f.sku || await nextSku(f.category_id);
  const id = await db.insert('INSERT INTO items (name,sku,category_id,quantity,min_quantity,location,notes,unit,rate,vendor,vendor_email) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [f.name, f.sku, f.category_id, f.quantity, f.min_quantity, f.location, f.notes, f.unit, f.rate, f.vendor, f.vendor_email]);
  await audit(req, 'create', 'item', id, `${f.name} [${f.sku}] (opening qty ${f.quantity})`);
  res.status(201).json(await db.get(`${ITEM_SQL} WHERE i.id=?`, [id]));
}));
app.put('/api/items/:id', manager, wrap(async (req, res) => {
  const id = int(req.params.id);
  const f = itemFields(req.body); if (typeof f === 'string') return bad(res, f);
  const old = await db.get('SELECT * FROM items WHERE id=?', [id]);
  if (!old) return bad(res, 'Item not found', 404);
  f.sku = f.sku || old.sku || await nextSku(f.category_id);
  const delta = f.quantity - old.quantity;
  if (delta) await assertOpen(today());
  await tx(async (t) => {
    await t.run('UPDATE items SET name=?,sku=?,category_id=?,quantity=?,min_quantity=?,location=?,notes=?,unit=?,rate=?,vendor=?,vendor_email=? WHERE id=?',
      [f.name, f.sku, f.category_id, f.quantity, f.min_quantity, f.location, f.notes, f.unit, f.rate, f.vendor, f.vendor_email, id]);
    // Quantity edits are recorded as adjustments so month reports stay reconcilable.
    if (delta) await t.run('INSERT INTO adjustments (item_id,delta,reason,note,created_by,created_at) VALUES (?,?,?,?,?,?)', [id, delta, 'Edited item', null, req.user.id, stamp()]);
  });
  const changed = ['name', 'sku', 'category_id', 'quantity', 'min_quantity', 'location', 'unit', 'rate', 'vendor'].filter((k) => (old[k] ?? null) !== (f[k] ?? null)).map((k) => `${k}: ${old[k] ?? '-'} → ${f[k] ?? '-'}`);
  await audit(req, 'update', 'item', id, `${old.name}: ${changed.join('; ') || 'no field changes'}`);
  res.json(await db.get(`${ITEM_SQL} WHERE i.id=?`, [id]));
}));
app.delete('/api/items/:id', admin, wrap(async (req, res) => {
  const old = await db.get('SELECT name,quantity FROM items WHERE id=?', [int(req.params.id)]);
  await db.run('DELETE FROM items WHERE id=?', [int(req.params.id)]);
  await audit(req, 'delete', 'item', int(req.params.id), old ? `${old.name} (qty ${old.quantity})` : null);
  res.json({ ok: true });
}));

const REASONS = ['Damage', 'Loss', 'Recount', 'Expired', 'Other'];
app.post('/api/items/:id/adjust', manager, wrap(async (req, res) => {
  const id = int(req.params.id), delta = int(req.body.delta), reason = req.body.reason;
  if (!Number.isInteger(delta) || delta === 0) return bad(res, 'Enter a non-zero adjustment');
  if (!REASONS.includes(reason)) return bad(res, 'Choose a reason');
  const item = await db.get('SELECT * FROM items WHERE id=?', [id]);
  if (!item) return bad(res, 'Item not found', 404);
  if (item.quantity + delta < 0) return bad(res, `Only ${item.quantity} in stock`);
  await assertOpen(today());
  await tx(async (t) => {
    await t.run('UPDATE items SET quantity=quantity+? WHERE id=?', [delta, id]);
    await t.run('INSERT INTO adjustments (item_id,delta,reason,note,created_by,created_at) VALUES (?,?,?,?,?,?)', [id, delta, reason, req.body.note || null, req.user.id, stamp()]);
  });
  if (delta < 0) notifyLow(id, item.quantity);
  await audit(req, 'adjust', 'item', id, `${item.name}: ${delta > 0 ? '+' : ''}${delta} (${reason})${req.body.note ? ' - ' + req.body.note : ''}`);
  res.json({ ok: true });
}));

// Purchases (stock in)
const PAYMENT_METHODS = ['Cash', 'Debit card', 'Razorpay'];
function paymentFields(b) {
  const method = (b.payment_method || '').trim();
  if (!PAYMENT_METHODS.includes(method)) return 'Choose a payment method';
  const ref = (b.payment_ref || '').trim() || null;
  if (method === 'Razorpay' && !ref) return 'Enter the Razorpay payment ID';
  return { method, ref: method === 'Cash' ? null : ref };
}
app.get('/api/purchases', wrap(async (req, res) => res.json(await db.all(
  'SELECT p.*,i.name item_name,i.unit FROM purchases p JOIN items i ON i.id=p.item_id ORDER BY p.purchased_at DESC, p.id DESC'))));
app.post('/api/purchases', manager, wrap(async (req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity), rate = Number(req.body.rate);
  const date = req.body.purchased_at || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'Invalid date');
  if (date > today()) return bad(res, "Date can't be in the future");
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  if (!(rate >= 0)) return bad(res, 'Rate must be 0 or more');
  const item = await db.get('SELECT * FROM items WHERE id=?', [itemId]);
  if (!item) return bad(res, 'Item not found', 404);
  await assertOpen(date);
  const vendor = (req.body.vendor || '').trim() || item.vendor || null;
  const challan = (req.body.challan_no || '').trim() || null;
  const pay = paymentFields(req.body); if (typeof pay === 'string') return bad(res, pay);
  await tx(async (t) => {
    await t.run('INSERT INTO purchases (item_id,quantity,rate,challan_no,vendor,purchased_at,created_by,payment_method,payment_ref) VALUES (?,?,?,?,?,?,?,?,?)', [itemId, qty, rate, challan, vendor, date, req.user.id, pay.method, pay.ref]);
    // The item's current rate follows its latest purchase, as in the paper register.
    await t.run('UPDATE items SET quantity=quantity+?, rate=?, vendor=COALESCE(vendor,?) WHERE id=?', [qty, rate, vendor, itemId]);
  });
  await audit(req, 'purchase', 'item', itemId, `${item.name}: +${qty} @ ${rate}${challan ? ` (challan ${challan})` : ''}`);
  res.status(201).json({ ok: true });
}));

// Purchase orders: draft -> sent (emailed to vendor) -> received (stock in + purchases recorded) or cancelled.
const PO_SQL = `SELECT o.*, u.name created_by_name,
  (SELECT COALESCE(SUM(l.quantity*l.rate),0) FROM po_lines l WHERE l.po_id=o.id) total,
  (SELECT COUNT(*) FROM po_lines l WHERE l.po_id=o.id) line_count
  FROM purchase_orders o LEFT JOIN users u ON u.id=o.created_by`;
const poLines = (id, ex = db) => ex.all('SELECT l.*, i.name item_name, i.sku, i.unit FROM po_lines l JOIN items i ON i.id=l.item_id WHERE l.po_id=? ORDER BY l.id', [id]);
async function createPo(t, { vendor, vendor_email, notes, lines }, userId) {
  const id = await t.insert('INSERT INTO purchase_orders (vendor,vendor_email,notes,created_by,created_at) VALUES (?,?,?,?,?)', [vendor, vendor_email || null, notes || null, userId, stamp()]);
  const poNo = `PO-${stamp().slice(0, 4)}-${String(id).padStart(4, '0')}`;
  await t.run('UPDATE purchase_orders SET po_no=? WHERE id=?', [poNo, id]);
  for (const l of lines) await t.run('INSERT INTO po_lines (po_id,item_id,quantity,rate) VALUES (?,?,?,?)', [id, l.item_id, l.quantity, l.rate]);
  return { id, poNo };
}
app.get('/api/mail-status', manager, wrap((req, res) => res.json({ configured: mailReady() })));
app.get('/api/purchase-orders', manager, wrap(async (req, res) => res.json(await db.all(`${PO_SQL} ORDER BY o.id DESC`))));
app.get('/api/purchase-orders/:id', manager, wrap(async (req, res) => {
  const po = await db.get(`${PO_SQL} WHERE o.id=?`, [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  res.json({ ...po, lines: await poLines(po.id) });
}));
app.post('/api/purchase-orders', manager, wrap(async (req, res) => {
  const vendor = (req.body.vendor || '').trim();
  if (!vendor) return bad(res, 'Vendor is required');
  const lines = [];
  for (const l of req.body.lines || []) {
    const item_id = int(l.item_id), quantity = int(l.quantity), rate = Number(l.rate || 0);
    if (!item_id && !l.quantity) continue;
    if (!item_id || !(quantity > 0) || !(rate >= 0)) return bad(res, 'Each line needs an item, a quantity of at least 1 and a valid rate');
    if (!(await db.get('SELECT 1 FROM items WHERE id=?', [item_id]))) return bad(res, 'Item not found', 404);
    lines.push({ item_id, quantity, rate });
  }
  if (!lines.length) return bad(res, 'Add at least one item');
  const { id, poNo } = await tx((t) => createPo(t, { ...req.body, vendor, lines }, req.user.id));
  await audit(req, 'create', 'purchase_order', id, `${poNo} to ${vendor}`);
  res.status(201).json({ id, po_no: poNo });
}));
// One draft PO per vendor for every item at/below its minimum level that isn't already on an open PO.
app.post('/api/purchase-orders/from-low-stock', manager, wrap(async (req, res) => {
  const low = await db.all(`SELECT i.* FROM items i WHERE i.min_quantity > 0 AND i.quantity <= i.min_quantity
    AND NOT EXISTS (SELECT 1 FROM po_lines l JOIN purchase_orders o ON o.id=l.po_id WHERE l.item_id=i.id AND o.status IN ('draft','sent')) ORDER BY i.vendor, i.name`);
  const byVendor = new Map();
  for (const it of low) {
    const v = it.vendor || 'Unassigned vendor';
    if (!byVendor.has(v)) byVendor.set(v, { vendor: v, vendor_email: it.vendor_email, lines: [] });
    const g = byVendor.get(v);
    g.vendor_email ||= it.vendor_email;
    g.lines.push({ item_id: it.id, quantity: Math.max(it.min_quantity * 2 - it.quantity, 1), rate: it.rate || 0 });
  }
  const made = [];
  for (const g of byVendor.values()) {
    const { id, poNo } = await tx((t) => createPo(t, { ...g, notes: 'Auto-drafted from low stock' }, req.user.id));
    await audit(req, 'create', 'purchase_order', id, `${poNo} to ${g.vendor} (low stock)`);
    made.push(poNo);
  }
  res.status(201).json({ created: made });
}));
app.post('/api/purchase-orders/:id/send', manager, wrap(async (req, res) => {
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=?', [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  if (!['draft', 'sent'].includes(po.status)) return bad(res, `A ${po.status} order can't be sent`);
  const to = (req.body.email || po.vendor_email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return bad(res, 'Enter a valid vendor email address');
  const lines = await poLines(po.id);
  await sendMail({ to, cc: await alertRecipients(), subject: `Purchase Order ${po.po_no} - MCCIA`, html: poEmail(po, lines) });
  await db.run(`UPDATE purchase_orders SET status='sent', sent_at=?, vendor_email=? WHERE id=?`, [stamp(), to, po.id]);
  await audit(req, 'send', 'purchase_order', po.id, `${po.po_no} emailed to ${to}`);
  res.json({ ok: true });
}));
app.post('/api/purchase-orders/:id/cancel', manager, wrap(async (req, res) => {
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=?', [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  if (!['draft', 'sent'].includes(po.status)) return bad(res, `A ${po.status} order can't be cancelled`);
  await db.run(`UPDATE purchase_orders SET status='cancelled' WHERE id=?`, [po.id]);
  await audit(req, 'cancel', 'purchase_order', po.id, po.po_no);
  res.json({ ok: true });
}));
// Receiving a PO books each line as a purchase (stock in) with the payment details.
app.post('/api/purchase-orders/:id/receive', manager, wrap(async (req, res) => {
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=?', [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  if (!['draft', 'sent'].includes(po.status)) return bad(res, `A ${po.status} order can't be received`);
  const pay = paymentFields(req.body); if (typeof pay === 'string') return bad(res, pay);
  const date = today(), challan = (req.body.challan_no || '').trim() || null;
  await assertOpen(date);
  const lines = await poLines(po.id);
  await tx(async (t) => {
    for (const l of lines) {
      await t.run('INSERT INTO purchases (item_id,quantity,rate,challan_no,vendor,purchased_at,created_by,payment_method,payment_ref) VALUES (?,?,?,?,?,?,?,?,?)', [l.item_id, l.quantity, l.rate, challan, po.vendor, date, req.user.id, pay.method, pay.ref]);
      await t.run('UPDATE items SET quantity=quantity+?, rate=?, vendor=COALESCE(vendor,?) WHERE id=?', [l.quantity, l.rate, po.vendor, l.item_id]);
    }
    await t.run(`UPDATE purchase_orders SET status='received', received_at=? WHERE id=?`, [stamp(), po.id]);
  });
  await audit(req, 'receive', 'purchase_order', po.id, `${po.po_no}: ${lines.length} lines, paid by ${pay.method}`);
  res.json({ ok: true });
}));

// Issues
app.get('/api/issues', manager, wrap(async (req, res) => res.json(await db.all(
  'SELECT s.*,i.name item_name,u.name issued_by_name FROM issues s JOIN items i ON i.id=s.item_id LEFT JOIN users u ON u.id=s.issued_by ORDER BY s.issued_at DESC, s.id DESC'))));
app.post('/api/issues', manager, wrap(async (req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity), to = (req.body.issued_to || '').trim();
  if (!to) return bad(res, 'Issued-to is required');
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  const item = await db.get('SELECT * FROM items WHERE id=?', [itemId]);
  if (!item) return bad(res, 'Item not found', 404);
  if (item.quantity < qty) return bad(res, `Only ${item.quantity} in stock`);
  await assertOpen(today());
  await tx(async (t) => {
    await t.run('UPDATE items SET quantity=quantity-? WHERE id=?', [qty, itemId]);
    await t.run('INSERT INTO issues (item_id,quantity,issued_to,department,event,issued_by,issued_at) VALUES (?,?,?,?,?,?,?)', [itemId, qty, to, req.body.department || null, req.body.event || null, req.user.id, stamp()]);
  });
  notifyLow(itemId, item.quantity);
  await audit(req, 'issue', 'item', itemId, `${qty} × ${item.name} → ${to}`);
  res.status(201).json({ ok: true });
}));

// Daily entry: several consumed items for one person/event in one go.
app.post('/api/issues/batch', manager, wrap(async (req, res) => {
  const { date = today(), issued_to = '', event = '', department = '', lines = [] } = req.body;
  const to = issued_to.trim();
  if (!to) return bad(res, 'Person name is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'Invalid date');
  if (date > today()) return bad(res, "Date can't be in the future");
  await assertOpen(date);
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
    const it = await db.get('SELECT * FROM items WHERE id=?', [id]);
    if (!it) return bad(res, 'Item not found', 404);
    if (it.quantity < q) return bad(res, `${it.name}: only ${it.quantity} in stock`);
    items.set(id, it);
  }
  const when = `${date} 00:00:00`;
  await tx(async (t) => {
    for (const [id, q] of need) {
      await t.run('UPDATE items SET quantity=quantity-? WHERE id=?', [q, id]);
      await t.run('INSERT INTO issues (item_id,quantity,issued_to,department,event,issued_by,issued_at,returned_at,consumed) VALUES (?,?,?,?,?,?,?,?,1)',
        [id, q, to, department || null, event || null, req.user.id, when, when]);
    }
  });
  for (const [id, it] of items) notifyLow(id, it.quantity);
  await audit(req, 'consume', 'issue', null, `${date} ${to}${event ? ` (${event})` : ''}: ${[...need].map(([id, q]) => `${q} × ${items.get(id).name}`).join(', ')}`);
  res.status(201).json({ ok: true, count: need.size });
}));
app.post('/api/issues/:id/return', manager, wrap(async (req, res) => {
  const iss = await db.get('SELECT s.*,i.name item_name FROM issues s JOIN items i ON i.id=s.item_id WHERE s.id=?', [int(req.params.id)]);
  if (!iss) return bad(res, 'Not found', 404);
  if (iss.consumed) return bad(res, 'Consumed items cannot be returned');
  if (iss.returned_at) return bad(res, 'Already returned');
  await assertOpen(today());
  await tx(async (t) => {
    await t.run('UPDATE issues SET returned_at=? WHERE id=?', [stamp(), iss.id]);
    await t.run('UPDATE items SET quantity=quantity+? WHERE id=?', [iss.quantity, iss.item_id]);
  });
  await audit(req, 'return', 'item', iss.item_id, `${iss.quantity} × ${iss.item_name} from ${iss.issued_to}`);
  res.json({ ok: true });
}));

// Staff requests: staff ask for items, managers fulfil (which issues the stock) or reject.
const REQ_SQL = `SELECT r.*, i.name item_name, i.quantity stock, u.name requester_name, u.office requester_office, rb.name resolved_by_name,
  (SELECT COUNT(*) FROM queries q WHERE q.request_id=r.id AND q.status='open') open_queries
  FROM requests r JOIN items i ON i.id=r.item_id LEFT JOIN users u ON u.id=r.requested_by LEFT JOIN users rb ON rb.id=r.resolved_by`;
const isMgr = (u) => u.role === 'admin' || u.role === 'manager';
app.get('/api/requests', wrap(async (req, res) => res.json(isMgr(req.user)
  ? await db.all(`${REQ_SQL} ORDER BY r.id DESC`)
  : await db.all(`${REQ_SQL} WHERE r.requested_by=? ORDER BY r.id DESC`, [req.user.id])))); 
app.post('/api/requests', wrap(async (req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity);
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  const item = await db.get('SELECT * FROM items WHERE id=?', [itemId]);
  if (!item) return bad(res, 'Item not found', 404);
  const id = await db.insert('INSERT INTO requests (item_id,quantity,note,requested_by,requested_at) VALUES (?,?,?,?,?)', [itemId, qty, (req.body.note || '').trim() || null, req.user.id, stamp()]);
  await audit(req, 'request', 'item', itemId, `${qty} × ${item.name} requested by ${req.user.name}`);
  res.status(201).json({ id });
}));
app.post('/api/requests/:id/cancel', wrap(async (req, res) => {
  const r = await db.get('SELECT * FROM requests WHERE id=?', [int(req.params.id)]);
  if (!r || r.requested_by !== req.user.id) return bad(res, 'Not found', 404);
  if (r.status !== 'pending') return bad(res, 'Only pending requests can be cancelled');
  await db.run(`UPDATE requests SET status='cancelled', resolved_at=? WHERE id=?`, [stamp(), r.id]);
  res.json({ ok: true });
}));
app.post('/api/requests/:id/fulfill', manager, wrap(async (req, res) => {
  const r = await db.get(`${REQ_SQL} WHERE r.id=?`, [int(req.params.id)]);
  if (!r) return bad(res, 'Not found', 404);
  if (r.status !== 'pending') return bad(res, 'Request is not pending');
  if (r.stock < r.quantity) return bad(res, `Only ${r.stock} in stock`);
  await assertOpen(today());
  await tx(async (t) => {
    const now = stamp();
    await t.run('UPDATE items SET quantity=quantity-? WHERE id=?', [r.quantity, r.item_id]);
    const issueId = await t.insert('INSERT INTO issues (item_id,quantity,issued_to,department,issued_by,issued_at) VALUES (?,?,?,?,?,?)', [r.item_id, r.quantity, r.requester_name || 'Staff', r.requester_office || null, req.user.id, now]);
    await t.run(`UPDATE requests SET status='fulfilled', resolved_by=?, resolved_at=?, issue_id=? WHERE id=?`, [req.user.id, now, issueId, r.id]);
  });
  notifyLow(r.item_id, r.stock);
  await audit(req, 'issue', 'item', r.item_id, `${r.quantity} × ${r.item_name} → ${r.requester_name} (request #${r.id})`);
  res.json({ ok: true });
}));
app.post('/api/requests/:id/reject', manager, wrap(async (req, res) => {
  const r = await db.get('SELECT * FROM requests WHERE id=?', [int(req.params.id)]);
  if (!r) return bad(res, 'Not found', 404);
  if (r.status !== 'pending') return bad(res, 'Request is not pending');
  await db.run(`UPDATE requests SET status='rejected', resolved_by=?, resolved_at=?, reject_reason=? WHERE id=?`, [req.user.id, stamp(), (req.body.reason || '').trim() || null, r.id]);
  await audit(req, 'reject', 'request', r.id, req.body.reason || null);
  res.json({ ok: true });
}));

// Queries: the requester says a fulfilled item was not received; a manager responds.
app.get('/api/queries', wrap(async (req, res) => {
  const sql = `SELECT q.*, r.quantity, i.name item_name, u.name raised_by_name, rb.name resolved_by_name
    FROM queries q JOIN requests r ON r.id=q.request_id JOIN items i ON i.id=r.item_id
    LEFT JOIN users u ON u.id=q.raised_by LEFT JOIN users rb ON rb.id=q.resolved_by`;
  res.json(isMgr(req.user) ? await db.all(`${sql} ORDER BY q.id DESC`) : await db.all(`${sql} WHERE q.raised_by=? ORDER BY q.id DESC`, [req.user.id]));
}));
app.post('/api/requests/:id/query', wrap(async (req, res) => {
  const r = await db.get('SELECT * FROM requests WHERE id=?', [int(req.params.id)]);
  if (!r || r.requested_by !== req.user.id) return bad(res, 'Not found', 404);
  if (r.status !== 'fulfilled') return bad(res, 'You can only raise a query on a fulfilled request');
  const message = (req.body.message || '').trim();
  if (!message) return bad(res, 'Please describe the problem');
  if (await db.get(`SELECT 1 FROM queries WHERE request_id=? AND status='open'`, [r.id])) return bad(res, 'A query is already open for this request');
  const id = await db.insert('INSERT INTO queries (request_id,message,raised_by,created_at) VALUES (?,?,?,?)', [r.id, message, req.user.id, stamp()]);
  await audit(req, 'query', 'request', r.id, message);
  res.status(201).json({ id });
}));
app.post('/api/queries/:id/resolve', manager, wrap(async (req, res) => {
  const q = await db.get('SELECT * FROM queries WHERE id=?', [int(req.params.id)]);
  if (!q) return bad(res, 'Not found', 404);
  if (q.status !== 'open') return bad(res, 'Already resolved');
  await db.run(`UPDATE queries SET status='resolved', response=?, resolved_by=?, resolved_at=? WHERE id=?`, [(req.body.response || '').trim() || null, req.user.id, stamp(), q.id]);
  await audit(req, 'resolve_query', 'request', q.request_id, req.body.response || null);
  res.json({ ok: true });
}));

// Monthly register
app.get('/api/reports/months', wrap(async (req, res) => res.json(await listMonths())));
const monthParam = (req) => { if (!MONTH_RE.test(req.params.month)) fail('Invalid month'); return req.params.month; };
app.get('/api/reports/:month', wrap(async (req, res) => res.json(await buildReport(monthParam(req)))));
app.get('/api/reports/:month/export', wrap(async (req, res) => {
  const month = monthParam(req);
  const wb = await reportWorkbook(month);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="MCCIA-Stock-Register-${month}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));
app.post('/api/reports/:month/close', manager, wrap(async (req, res) => {
  const month = monthParam(req);
  if (month > today().slice(0, 7)) return bad(res, "Can't close a future month");
  if (await db.get('SELECT 1 FROM closed_months WHERE month=?', [month])) return bad(res, 'Already closed');
  const n = await closeMonth(month, req.user.id);
  await audit(req, 'close_month', 'month', null, `${month}: ${n} items frozen`);
  res.json({ ok: true });
}));
app.delete('/api/reports/:month/close', manager, wrap(async (req, res) => {
  const month = monthParam(req);
  const c = await db.get('SELECT * FROM closed_months WHERE month=?', [month]);
  if (!c) return bad(res, 'Month is not closed');
  if (c.closed_by == null) return bad(res, 'Imported months cannot be reopened');
  if (await db.get('SELECT 1 FROM closed_months WHERE month>?', [month])) return bad(res, 'Reopen later months first');
  await tx(async (t) => { await t.run('DELETE FROM month_closings WHERE month=?', [month]); await t.run('DELETE FROM closed_months WHERE month=?', [month]); });
  await audit(req, 'reopen_month', 'month', null, month);
  res.json({ ok: true });
}));

// Insights
app.get('/api/insights', wrap(async (req, res) => {
  const m = req.query.month || 'all';
  if (m !== 'all' && !MONTH_RE.test(m)) return bad(res, 'Invalid month');
  res.json({ ...(await consumption(m)), trend: await trend() });
}));
app.get('/api/insights/reorder', wrap(async (req, res) => res.json(await reorder())));

// Audit log
app.get('/api/audit', admin, wrap(async (req, res) => {
  const entity = req.query.entity;
  const rows = entity
    ? await db.all('SELECT * FROM audit_log WHERE entity=? ORDER BY id DESC LIMIT 300', [entity])
    : await db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300');
  res.json(rows);
}));

// Users
app.get('/api/users', admin, wrap(async (req, res) => res.json(await db.all('SELECT id,name,email,role,office FROM users ORDER BY name'))));
app.post('/api/users', admin, wrap(async (req, res) => {
  const { name = '', email = '', password = '', role = 'staff', office = '' } = req.body;
  if (!name.trim() || !email.trim() || password.length < 6) return bad(res, 'Name, email and a 6+ character password are required');
  if (!['admin', 'manager', 'staff'].includes(role)) return bad(res, 'Invalid role');
  if (!OFFICES.includes(office.trim())) return bad(res, 'Choose a valid office');
  const id = await db.insert('INSERT INTO users (name,email,password_hash,role,office) VALUES (?,?,?,?,?)', [name.trim(), email.trim().toLowerCase(), hashPassword(password), role, office.trim()]);
  await audit(req, 'create', 'user', id, `${email.trim().toLowerCase()} (${role}, ${office.trim()})`);
  res.status(201).json({ ok: true });
}));
app.post('/api/users/:id/password', admin, wrap(async (req, res) => {
  const id = int(req.params.id), password = req.body.password || '';
  if (password.length < 6) return bad(res, 'Password must be at least 6 characters');
  const u = await db.get('SELECT email FROM users WHERE id=?', [id]);
  if (!u) return bad(res, 'User not found', 404);
  await db.run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(password), id]);
  await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
  await audit(req, 'password_reset', 'user', id, u.email);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', admin, wrap(async (req, res) => {
  const id = int(req.params.id);
  if (id === req.user.id) return bad(res, "You can't delete yourself");
  const u = await db.get('SELECT email FROM users WHERE id=?', [id]);
  // Keep history: issues reference the user, so detach rather than fail the delete.
  await tx(async (t) => {
    await t.run('UPDATE issues SET issued_by=NULL WHERE issued_by=?', [id]);
    await t.run('DELETE FROM users WHERE id=?', [id]);
  });
  await audit(req, 'delete', 'user', id, u?.email);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => bad(res, `No such endpoint: ${req.method} ${req.originalUrl}`, 404));

// Serve built client if present (single-host setup); on Vercel + Render the client is hosted separately.
const dist = fileURLToPath(new URL('../client/dist', import.meta.url));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(dist + '/index.html'));
}
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API on http://localhost:${port}`));
