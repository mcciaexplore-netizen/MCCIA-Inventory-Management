import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import cors from 'cors';
import { parse as parseCookie } from 'cookie';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { db, tx, hashPassword, verifyPassword, stamp, OFFICES } from './db.js';
import {
  ORG, alertRecipients, lowStockEmail, mailReady, maintenanceClosedEmail, maintenanceOpenEmail,
  maintenanceRecipients, poEmail, requestClosedEmail, requestOpenEmail, sendMail,
} from './mail.js';
import { MCCIA_GSTIN, PO_SIGNATORY, PO_SIGNATORY_TITLE, TERMS, buildPoDocx } from './poDocument.js';

const app = express();
app.set('trust proxy', 1); // behind Vercel's proxy: req.ip must read the real client IP, not the proxy's.
// Client and API share one origin in both dev (Vite proxy) and prod (Vercel rewrite), so cross-origin
// access isn't needed by default; set CORS_ORIGIN (comma-separated) only if a separate domain needs it.
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false, credentials: corsOrigins.length > 0 }));
app.use(express.json());
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// Generic per-IP throttle against scripted abuse across the whole API (the DB-backed per-email
// lockout below still governs actual login brute-forcing). Resets on each serverless cold start,
// so it's a coarse defense-in-depth layer, not the only one.
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-up attempts. Try again later.' } });
const passwordChangeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many password-change attempts. Try again later.' } });

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
// Rejects any scheme other than http(s) so a stored URL can't become a `javascript:` link
// when rendered as <a href> in emails or in the app (e.g. maintenance photo URLs).
const isHttpUrl = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
const today = () => stamp().slice(0, 10);

const audit = (req, action, entity, entityId, detail) =>
  db.run('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,detail,created_at) VALUES (?,?,?,?,?,?,?)',
    [req.user?.id ?? null, req.user?.name ?? null, action, entity, entityId ?? null, detail ?? null, stamp()]);
// Takes stock out only if enough is left at that moment, so simultaneous issues can't go negative.
async function takeStock(t, itemId, qty) {
  if (!(await t.get('UPDATE items SET quantity=quantity-? WHERE id=? AND quantity>=? RETURNING id', [qty, itemId, qty]))) {
    const it = await t.get('SELECT name,quantity FROM items WHERE id=?', [itemId]);
    fail(it ? `${it.name}: only ${it.quantity} in stock` : 'Item not found');
  }
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

// Notification emails below are all best-effort: a failed send is logged but never blocks the
// underlying action, since the request/ticket itself has already been committed to the database.
async function notifyRequestOpened(r) {
  try {
    const to = await alertRecipients();
    if (mailReady() && to.length) await sendMail({ to, subject: `New request: ${r.quantity} × ${r.item_name}`, html: requestOpenEmail(r) });
  } catch (e) { console.error('request-opened alert failed:', e.message); }
}
async function notifyRequestClosed(r, requesterEmail) {
  try {
    if (mailReady() && requesterEmail) {
      await sendMail({ to: requesterEmail, subject: `Request ${r.status}: ${r.quantity} × ${r.item_name}`, html: requestClosedEmail(r) });
    }
  } catch (e) { console.error('request-closed alert failed:', e.message); }
}
async function notifyMaintenanceOpened(ticket) {
  try {
    const to = await maintenanceRecipients();
    if (mailReady() && to.length) await sendMail({ to, subject: 'New maintenance complaint', html: maintenanceOpenEmail(ticket) });
  } catch (e) { console.error('maintenance-opened alert failed:', e.message); }
}
async function notifyMaintenanceClosed(ticket, raisedByEmail) {
  try {
    if (mailReady() && raisedByEmail) {
      await sendMail({ to: raisedByEmail, subject: 'Maintenance complaint resolved', html: maintenanceClosedEmail(ticket) });
    }
  } catch (e) { console.error('maintenance-closed alert failed:', e.message); }
}

const SESSION_DAYS = 30;
const SESSION_COOKIE = 'session';
// Secure cookies require HTTPS; only the Vercel deployment serves over HTTPS, so dev (plain http://localhost) needs it off.
const isProd = !!process.env.VERCEL;
const setSessionCookie = (res, token) => res.cookie(SESSION_COOKIE, token, {
  httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: SESSION_DAYS * 864e5, path: '/',
});
const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, { path: '/' });
const daysAgo = (n) => stamp(new Date(Date.now() - n * 864e5));
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, office: u.office, must_change_password: !!u.must_change_password });

const auth = wrap(async (req, res, next) => {
  const token = parseCookie(req.headers.cookie || '')[SESSION_COOKIE] || '';
  const user = token && await db.get(`SELECT u.id,u.name,u.email,u.role,u.office,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.created_at > ? AND u.approved`, [token, daysAgo(SESSION_DAYS)]);
  if (!user) return bad(res, 'Unauthorized', 401);
  req.user = user; req.token = token;
  // Until the default/reset password is replaced, only the account endpoints work.
  if (user.must_change_password && !['/me', '/me/password', '/logout'].includes(req.path)) return bad(res, 'Change your password to continue', 403);
  next();
});
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : bad(res, 'Admin only', 403));
const employee = (req, res, next) => (['admin', 'employee'].includes(req.user.role) ? next() : bad(res, 'Employee or admin only', 403));
const staffOrAdmin = (req, res, next) => (['admin', 'staff'].includes(req.user.role) ? next() : bad(res, 'Staff or admin only', 403));

app.get('/api/offices', wrap((req, res) => res.json(OFFICES)));
// Failed logins are counted per email in the database (not memory), so the limit holds across serverless instances.
const MAX_FAILURES = 5, LOCK_MINUTES = 15;
app.post('/api/login', wrap(async (req, res) => {
  const { email = '', password = '', office = '' } = req.body;
  const em = email.trim().toLowerCase();
  const since = stamp(new Date(Date.now() - LOCK_MINUTES * 6e4));
  if ((await db.get('SELECT COUNT(*) n FROM login_failures WHERE email=? AND at > ?', [em, since])).n >= MAX_FAILURES)
    return bad(res, `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`, 429);
  const u = await db.get('SELECT * FROM users WHERE email=?', [em]);
  if (!u || !verifyPassword(password, u.password_hash) || u.office.toLowerCase() !== String(office).trim().toLowerCase()) {
    await db.run('INSERT INTO login_failures (email,at) VALUES (?,?)', [em, stamp()]);
    return bad(res, 'Invalid email, password or office', 401);
  }
  if (!u.approved) return bad(res, 'Your account is waiting for an admin to approve it', 403);
  await db.run('DELETE FROM login_failures WHERE email=? OR at < ?', [em, since]);
  await db.run('DELETE FROM sessions WHERE created_at < ?', [daysAgo(SESSION_DAYS)]);
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)', [token, u.id, stamp()]);
  setSessionCookie(res, token);
  res.json({ user: publicUser(u) });
}));

// Self sign-up creates a pending staff account; an admin approves it under Users before it can sign in.
app.post('/api/register', registerLimiter, wrap(async (req, res) => {
  const { name = '', email = '', password = '', office = '' } = req.body;
  const em = email.trim().toLowerCase();
  if (!name.trim() || !em || password.length < 6) return bad(res, 'Name, email and a 6+ character password are required');
  if (!OFFICES.includes(office.trim())) return bad(res, 'Choose a valid office');
  if (await db.get('SELECT id FROM users WHERE email=?', [em])) return bad(res, 'An account with this email already exists');
  const id = await db.insert('INSERT INTO users (name,email,password_hash,role,office,approved) VALUES (?,?,?,?,?,FALSE)', [name.trim(), em, hashPassword(password), 'staff', office.trim()]);
  await db.run('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,detail,created_at) VALUES (?,?,?,?,?,?,?)',
    [null, name.trim(), 'register', 'user', id, `${em} (${office.trim()}), awaiting approval`, stamp()]);
  res.status(202).json({ pending: true });
}));

app.use('/api', auth);
app.get('/api/me', (req, res) => res.json(publicUser(req.user)));
app.post('/api/logout', wrap(async (req, res) => { await db.run('DELETE FROM sessions WHERE token=?', [req.token]); clearSessionCookie(res); res.json({ ok: true }); }));
app.post('/api/me/password', passwordChangeLimiter, wrap(async (req, res) => {
  const { current_password = '', new_password = '' } = req.body;
  const u = await db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!verifyPassword(current_password, u.password_hash)) return bad(res, 'Current password is incorrect');
  if (new_password.length < 6) return bad(res, 'New password must be at least 6 characters');
  if (new_password === current_password) return bad(res, 'Choose a password different from the current one');
  await db.run('UPDATE users SET password_hash=?, must_change_password=FALSE WHERE id=?', [hashPassword(new_password), u.id]);
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

// Categories (read-only: items are grouped by category for filtering/reporting, but there is no
// dedicated management UI — new categories arrive via item creation or spreadsheet import).
app.get('/api/categories', wrap(async (req, res) => res.json(await db.all('SELECT c.*,(SELECT COUNT(*) FROM items WHERE category_id=c.id) item_count FROM categories c ORDER BY name'))));

// Vendors: a reusable address book (name, email, address, GSTIN, PAN) for filling in purchase orders.
app.get('/api/vendors', wrap(async (req, res) => res.json(await db.all('SELECT * FROM vendors ORDER BY name'))));
app.post('/api/vendors', employee, wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return bad(res, 'Name is required');
  const { email, address, gstin, pan } = req.body;
  const id = await db.insert('INSERT INTO vendors (name,email,address,gstin,pan) VALUES (?,?,?,?,?)', [name, email || null, address || null, gstin || null, pan || null]);
  await audit(req, 'create', 'vendor', id, name);
  res.status(201).json({ id, name });
}));
app.post('/api/vendors/bulk', employee, wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return bad(res, 'No rows to import');
  if (rows.length > 2000) return bad(res, 'Import at most 2000 rows at a time');
  const names = new Set((await db.all('SELECT name FROM vendors')).map((r) => r.name.trim().toLowerCase()));
  let created = 0; const skipped = [], errors = [];
  for (const [n, r] of rows.entries()) {
    const name = String(r.name || '').trim();
    const label = `Row ${n + 1}${name ? ` (${name})` : ''}`;
    try {
      if (!name) { errors.push(`${label}: Name is required`); continue; }
      if (names.has(name.toLowerCase())) { skipped.push(name); continue; }
      const id = await db.insert('INSERT INTO vendors (name,email,address,gstin,pan) VALUES (?,?,?,?,?)',
        [name, r.email || null, r.address || null, r.gstin || null, r.pan || null]);
      names.add(name.toLowerCase()); created++;
      await audit(req, 'create', 'vendor', id, `${name} (bulk import)`);
    } catch (e) { errors.push(`${label}: ${e.message}`); }
  }
  res.json({ created, skipped, errors });
}));
app.delete('/api/vendors/:id', admin, wrap(async (req, res) => {
  const v = await db.get('SELECT name FROM vendors WHERE id=?', [int(req.params.id)]);
  await db.run('DELETE FROM vendors WHERE id=?', [int(req.params.id)]);
  await audit(req, 'delete', 'vendor', int(req.params.id), v?.name);
  res.json({ ok: true });
}));

// Items
const ITEM_SQL = 'SELECT i.*,c.name category FROM items i LEFT JOIN categories c ON c.id=i.category_id';
app.get('/api/items', wrap(async (req, res) => res.json(await db.all(`${ITEM_SQL} ORDER BY i.name`))));
function itemFields(b) {
  const name = (b.name || '').trim();
  const quantity = b.quantity === '' || b.quantity == null ? NaN : Number(b.quantity), min = Number(b.min_quantity || 0);
  if (!name) return 'Name required';
  if (!Number.isInteger(quantity) || !Number.isInteger(min) || quantity < 0 || min < 0) return 'Quantities must be whole numbers, 0 or more';
  const rate = b.rate === '' || b.rate == null ? null : Number(b.rate);
  if (rate !== null && !(rate >= 0)) return 'Rate must be 0 or more';
  return { name, category_id: b.category_id ? int(b.category_id) : null, quantity, min_quantity: min, location: b.location || null, notes: b.notes || null, unit: (b.unit || '').trim() || null, rate, vendor: (b.vendor || '').trim() || null, vendor_email: (b.vendor_email || '').trim() || null };
}
app.post('/api/items', employee, wrap(async (req, res) => {
  const f = itemFields(req.body); if (typeof f === 'string') return bad(res, f);
  const id = await db.insert('INSERT INTO items (name,category_id,quantity,min_quantity,location,notes,unit,rate,vendor,vendor_email) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [f.name, f.category_id, f.quantity, f.min_quantity, f.location, f.notes, f.unit, f.rate, f.vendor, f.vendor_email]);
  await audit(req, 'create', 'item', id, `${f.name} (opening qty ${f.quantity})`);
  res.status(201).json(await db.get(`${ITEM_SQL} WHERE i.id=?`, [id]));
}));
// Bulk import: rows are parsed in the browser (Excel/CSV/PDF); existing item names are skipped.
app.post('/api/items/bulk', employee, wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return bad(res, 'No rows to import');
  if (rows.length > 2000) return bad(res, 'Import at most 2000 rows at a time');
  const names = new Set((await db.all('SELECT name FROM items')).map((r) => r.name.trim().toLowerCase()));
  const cats = new Map((await db.all('SELECT id,name FROM categories')).map((c) => [c.name.toLowerCase(), c.id]));
  let created = 0; const skipped = [], errors = [];
  for (const [n, r] of rows.entries()) {
    const label = `Row ${n + 1}${r.name ? ` (${r.name})` : ''}`;
    try {
      const f = itemFields({ ...r, category_id: '' });
      if (typeof f === 'string') { errors.push(`${label}: ${f}`); continue; }
      if (names.has(f.name.toLowerCase())) { skipped.push(f.name); continue; }
      const cname = String(r.category || '').trim();
      if (cname) {
        if (!cats.has(cname.toLowerCase())) cats.set(cname.toLowerCase(), await db.insert('INSERT INTO categories (name) VALUES (?)', [cname]));
        f.category_id = cats.get(cname.toLowerCase());
      }
      const id = await db.insert('INSERT INTO items (name,category_id,quantity,min_quantity,location,notes,unit,rate,vendor,vendor_email) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [f.name, f.category_id, f.quantity, f.min_quantity, f.location, f.notes, f.unit, f.rate, f.vendor, f.vendor_email]);
      names.add(f.name.toLowerCase()); created++;
      await audit(req, 'create', 'item', id, `${f.name} (opening qty ${f.quantity}, bulk import)`);
    } catch (e) { errors.push(`${label}: ${e.message}`); }
  }
  res.json({ created, skipped, errors });
}));
app.put('/api/items/:id', employee, wrap(async (req, res) => {
  const id = int(req.params.id);
  const f = itemFields(req.body); if (typeof f === 'string') return bad(res, f);
  const old = await db.get('SELECT * FROM items WHERE id=?', [id]);
  if (!old) return bad(res, 'Item not found', 404);
  const delta = f.quantity - old.quantity;
  await tx(async (t) => {
    await t.run('UPDATE items SET name=?,category_id=?,quantity=?,min_quantity=?,location=?,notes=?,unit=?,rate=?,vendor=?,vendor_email=? WHERE id=?',
      [f.name, f.category_id, f.quantity, f.min_quantity, f.location, f.notes, f.unit, f.rate, f.vendor, f.vendor_email, id]);
    // Quantity edits are recorded as adjustments so stock history stays traceable.
    if (delta) await t.run('INSERT INTO adjustments (item_id,delta,reason,note,created_by,created_at) VALUES (?,?,?,?,?,?)', [id, delta, 'Edited item', null, req.user.id, stamp()]);
  });
  const changed = ['name', 'category_id', 'quantity', 'min_quantity', 'location', 'unit', 'rate', 'vendor'].filter((k) => (old[k] ?? null) !== (f[k] ?? null)).map((k) => `${k}: ${old[k] ?? '-'} → ${f[k] ?? '-'}`);
  await audit(req, 'update', 'item', id, `${old.name}: ${changed.join('; ') || 'no field changes'}`);
  res.json(await db.get(`${ITEM_SQL} WHERE i.id=?`, [id]));
}));
app.delete('/api/items/:id', admin, wrap(async (req, res) => {
  const old = await db.get('SELECT name,quantity FROM items WHERE id=?', [int(req.params.id)]);
  // Deleting would cascade away purchases, issues and adjustments, silently erasing stock history.
  const used = await db.get(`SELECT 1 FROM issues WHERE item_id=? UNION ALL SELECT 1 FROM purchases WHERE item_id=?
    UNION ALL SELECT 1 FROM adjustments WHERE item_id=? UNION ALL SELECT 1 FROM requests WHERE item_id=?
    UNION ALL SELECT 1 FROM po_lines WHERE item_id=? LIMIT 1`, Array(5).fill(int(req.params.id)));
  if (used) return bad(res, `${old?.name || 'This item'} has stock history, so it can't be deleted. Adjust its quantity to 0 instead.`);
  await db.run('DELETE FROM items WHERE id=?', [int(req.params.id)]);
  await audit(req, 'delete', 'item', int(req.params.id), old ? `${old.name} (qty ${old.quantity})` : null);
  res.json({ ok: true });
}));

const REASONS = ['Damage', 'Loss', 'Recount', 'Expired', 'Other'];
app.post('/api/items/:id/adjust', employee, wrap(async (req, res) => {
  const id = int(req.params.id), delta = int(req.body.delta), reason = req.body.reason;
  if (!Number.isInteger(delta) || delta === 0) return bad(res, 'Enter a non-zero adjustment');
  if (!REASONS.includes(reason)) return bad(res, 'Choose a reason');
  const item = await db.get('SELECT * FROM items WHERE id=?', [id]);
  if (!item) return bad(res, 'Item not found', 404);
  if (item.quantity + delta < 0) return bad(res, `Only ${item.quantity} in stock`);
  await tx(async (t) => {
    await t.run('UPDATE items SET quantity=quantity+? WHERE id=?', [delta, id]);
    await t.run('INSERT INTO adjustments (item_id,delta,reason,note,created_by,created_at) VALUES (?,?,?,?,?,?)', [id, delta, reason, req.body.note || null, req.user.id, stamp()]);
  });
  if (delta < 0) await notifyLow(id, item.quantity);
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
app.get('/api/purchases', employee, wrap(async (req, res) => res.json(await db.all(
  'SELECT p.*,i.name item_name,i.unit FROM purchases p JOIN items i ON i.id=p.item_id ORDER BY p.purchased_at DESC, p.id DESC'))));
app.post('/api/purchases', employee, wrap(async (req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity), rate = Number(req.body.rate);
  const date = req.body.purchased_at || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'Invalid date');
  if (date > today()) return bad(res, "Date can't be in the future");
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  if (!(rate >= 0)) return bad(res, 'Rate must be 0 or more');
  const item = await db.get('SELECT * FROM items WHERE id=?', [itemId]);
  if (!item) return bad(res, 'Item not found', 404);
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
const poLines = (id, ex = db) => ex.all('SELECT l.*, i.name item_name, i.unit FROM po_lines l JOIN items i ON i.id=l.item_id WHERE l.po_id=? ORDER BY l.id', [id]);
async function createPo(t, { vendor, vendor_email, vendor_address, vendor_gstin, vendor_pan, notes, lines }, userId) {
  const id = await t.insert(
    'INSERT INTO purchase_orders (vendor,vendor_email,vendor_address,vendor_gstin,vendor_pan,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [vendor, vendor_email || null, vendor_address || null, vendor_gstin || null, vendor_pan || null, notes || null, userId, stamp()],
  );
  const poNo = `PO-${stamp().slice(0, 4)}-${String(id).padStart(4, '0')}`;
  await t.run('UPDATE purchase_orders SET po_no=? WHERE id=?', [poNo, id]);
  for (const l of lines) await t.run('INSERT INTO po_lines (po_id,item_id,quantity,rate) VALUES (?,?,?,?)', [id, l.item_id, l.quantity, l.rate]);
  return { id, poNo };
}
app.get('/api/mail-status', employee, wrap((req, res) => res.json({ configured: mailReady() })));
// Letterhead details for rendering a PO preview client-side (kept in sync with the generated .docx).
app.get('/api/org', employee, wrap((req, res) => res.json({ name: ORG, gstin: MCCIA_GSTIN, signatory: PO_SIGNATORY, signatoryTitle: PO_SIGNATORY_TITLE, terms: TERMS })));
app.get('/api/purchase-orders', employee, wrap(async (req, res) => res.json(await db.all(`${PO_SQL} ORDER BY o.id DESC`))));
app.get('/api/purchase-orders/:id', employee, wrap(async (req, res) => {
  const po = await db.get(`${PO_SQL} WHERE o.id=?`, [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  res.json({ ...po, lines: await poLines(po.id) });
}));
// Generates the PO letter as a .docx on demand (not stored) so it always reflects the current record.
app.get('/api/purchase-orders/:id/document', employee, wrap(async (req, res) => {
  const po = await db.get(`${PO_SQL} WHERE o.id=?`, [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  const buffer = await buildPoDocx(po, await poLines(po.id));
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename="${po.po_no}.docx"`,
  });
  res.send(buffer);
}));
app.post('/api/purchase-orders', employee, wrap(async (req, res) => {
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
app.post('/api/purchase-orders/from-low-stock', employee, wrap(async (req, res) => {
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
app.post('/api/purchase-orders/:id/send', employee, wrap(async (req, res) => {
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=?', [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  if (!['draft', 'sent'].includes(po.status)) return bad(res, `A ${po.status} order can't be sent`);
  if (!mailReady()) return bad(res, 'Email is not configured on the server, so the PO can\'t be emailed', 503);
  const to = (req.body.email || po.vendor_email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return bad(res, 'Enter a valid vendor email address');
  const lines = await poLines(po.id);
  await sendMail({ to, cc: await alertRecipients(), subject: `Purchase Order ${po.po_no} - MCCIA`, html: poEmail(po, lines) });
  await db.run(`UPDATE purchase_orders SET status='sent', sent_at=?, vendor_email=? WHERE id=?`, [stamp(), to, po.id]);
  await audit(req, 'send', 'purchase_order', po.id, `${po.po_no} emailed to ${to}`);
  res.json({ ok: true });
}));
app.post('/api/purchase-orders/:id/cancel', employee, wrap(async (req, res) => {
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=?', [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  if (!['draft', 'sent'].includes(po.status)) return bad(res, `A ${po.status} order can't be cancelled`);
  await db.run(`UPDATE purchase_orders SET status='cancelled' WHERE id=?`, [po.id]);
  await audit(req, 'cancel', 'purchase_order', po.id, po.po_no);
  res.json({ ok: true });
}));
// Receiving a PO books each line as a purchase (stock in) with the payment details.
app.post('/api/purchase-orders/:id/receive', employee, wrap(async (req, res) => {
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=?', [int(req.params.id)]);
  if (!po) return bad(res, 'Not found', 404);
  if (!['draft', 'sent'].includes(po.status)) return bad(res, `A ${po.status} order can't be received`);
  const pay = paymentFields(req.body); if (typeof pay === 'string') return bad(res, pay);
  const date = today(), challan = (req.body.challan_no || '').trim() || null;
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
app.get('/api/issues', employee, wrap(async (req, res) => res.json(await db.all(
  'SELECT s.*,i.name item_name,u.name issued_by_name FROM issues s JOIN items i ON i.id=s.item_id LEFT JOIN users u ON u.id=s.issued_by ORDER BY s.issued_at DESC, s.id DESC'))));
app.post('/api/issues', employee, wrap(async (req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity), to = (req.body.issued_to || '').trim();
  if (!to) return bad(res, 'Issued-to is required');
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  const item = await db.get('SELECT * FROM items WHERE id=?', [itemId]);
  if (!item) return bad(res, 'Item not found', 404);
  if (item.quantity < qty) return bad(res, `Only ${item.quantity} in stock`);
  await tx(async (t) => {
    await takeStock(t, itemId, qty);
    await t.run('INSERT INTO issues (item_id,quantity,issued_to,department,event,issued_by,issued_at) VALUES (?,?,?,?,?,?,?)', [itemId, qty, to, req.body.department || null, req.body.event || null, req.user.id, stamp()]);
  });
  await notifyLow(itemId, item.quantity);
  await audit(req, 'issue', 'item', itemId, `${qty} × ${item.name} → ${to}`);
  res.status(201).json({ ok: true });
}));

app.post('/api/issues/:id/return', employee, wrap(async (req, res) => {
  const iss = await db.get('SELECT s.*,i.name item_name FROM issues s JOIN items i ON i.id=s.item_id WHERE s.id=?', [int(req.params.id)]);
  if (!iss) return bad(res, 'Not found', 404);
  if (iss.consumed) return bad(res, 'Consumed items cannot be returned');
  if (iss.returned_at) return bad(res, 'Already returned');
  await tx(async (t) => {
    await t.run('UPDATE issues SET returned_at=? WHERE id=?', [stamp(), iss.id]);
    await t.run('UPDATE items SET quantity=quantity+? WHERE id=?', [iss.quantity, iss.item_id]);
  });
  await audit(req, 'return', 'item', iss.item_id, `${iss.quantity} × ${iss.item_name} from ${iss.issued_to}`);
  res.json({ ok: true });
}));

// Staff requests: staff ask for items, employees fulfil (which issues the stock) or reject.
const REQ_SQL = `SELECT r.*, i.name item_name, i.quantity stock, u.name requester_name, u.office requester_office, u.email requester_email, rb.name resolved_by_name,
  (SELECT COUNT(*) FROM queries q WHERE q.request_id=r.id AND q.status='open') open_queries
  FROM requests r JOIN items i ON i.id=r.item_id LEFT JOIN users u ON u.id=r.requested_by LEFT JOIN users rb ON rb.id=r.resolved_by`;
const isEmployee = (u) => u.role === 'admin' || u.role === 'employee';
app.get('/api/requests', wrap(async (req, res) => res.json(isEmployee(req.user)
  ? await db.all(`${REQ_SQL} ORDER BY r.id DESC`)
  : await db.all(`${REQ_SQL} WHERE r.requested_by=? ORDER BY r.id DESC`, [req.user.id])))); 
app.post('/api/requests', wrap(async (req, res) => {
  const itemId = int(req.body.item_id), qty = int(req.body.quantity);
  if (!(qty > 0)) return bad(res, 'Quantity must be at least 1');
  const item = await db.get('SELECT * FROM items WHERE id=?', [itemId]);
  if (!item) return bad(res, 'Item not found', 404);
  const note = (req.body.note || '').trim() || null;
  const id = await db.insert('INSERT INTO requests (item_id,quantity,note,requested_by,requested_at) VALUES (?,?,?,?,?)', [itemId, qty, note, req.user.id, stamp()]);
  await audit(req, 'request', 'item', itemId, `${qty} × ${item.name} requested by ${req.user.name}`);
  await notifyRequestOpened({ item_name: item.name, quantity: qty, note, requester_name: req.user.name, requester_office: req.user.office });
  res.status(201).json({ id });
}));
app.post('/api/requests/:id/cancel', wrap(async (req, res) => {
  const r = await db.get('SELECT * FROM requests WHERE id=?', [int(req.params.id)]);
  if (!r || r.requested_by !== req.user.id) return bad(res, 'Not found', 404);
  if (r.status !== 'pending') return bad(res, 'Only pending requests can be cancelled');
  await db.run(`UPDATE requests SET status='cancelled', resolved_at=? WHERE id=?`, [stamp(), r.id]);
  res.json({ ok: true });
}));
app.post('/api/requests/:id/fulfill', employee, wrap(async (req, res) => {
  const r = await db.get(`${REQ_SQL} WHERE r.id=?`, [int(req.params.id)]);
  if (!r) return bad(res, 'Not found', 404);
  if (r.status !== 'pending') return bad(res, 'Request is not pending');
  if (r.stock < r.quantity) return bad(res, `Only ${r.stock} in stock`);
  await tx(async (t) => {
    const now = stamp();
    await takeStock(t, r.item_id, r.quantity);
    // Requested items are handed over for use, not lent, so they're recorded as consumed (not "on loan").
    const issueId = await t.insert('INSERT INTO issues (item_id,quantity,issued_to,department,issued_by,issued_at,returned_at,consumed) VALUES (?,?,?,?,?,?,?,1)', [r.item_id, r.quantity, r.requester_name || 'Staff', r.requester_office || null, req.user.id, now, now]);
    await t.run(`UPDATE requests SET status='fulfilled', resolved_by=?, resolved_at=?, issue_id=? WHERE id=?`, [req.user.id, now, issueId, r.id]);
  });
  await notifyLow(r.item_id, r.stock);
  await audit(req, 'issue', 'item', r.item_id, `${r.quantity} × ${r.item_name} → ${r.requester_name} (request #${r.id})`);
  await notifyRequestClosed({ ...r, status: 'fulfilled' }, r.requester_email);
  res.json({ ok: true });
}));
app.post('/api/requests/:id/reject', employee, wrap(async (req, res) => {
  const r = await db.get(`${REQ_SQL} WHERE r.id=?`, [int(req.params.id)]);
  if (!r) return bad(res, 'Not found', 404);
  if (r.status !== 'pending') return bad(res, 'Request is not pending');
  const reason = (req.body.reason || '').trim() || null;
  await db.run(`UPDATE requests SET status='rejected', resolved_by=?, resolved_at=?, reject_reason=? WHERE id=?`, [req.user.id, stamp(), reason, r.id]);
  await audit(req, 'reject', 'request', r.id, reason);
  await notifyRequestClosed({ ...r, status: 'rejected', reject_reason: reason }, r.requester_email);
  res.json({ ok: true });
}));

// Queries: the requester says a fulfilled item was not received; an employee responds.
app.get('/api/queries', wrap(async (req, res) => {
  const sql = `SELECT q.*, r.quantity, i.name item_name, u.name raised_by_name, rb.name resolved_by_name
    FROM queries q JOIN requests r ON r.id=q.request_id JOIN items i ON i.id=r.item_id
    LEFT JOIN users u ON u.id=q.raised_by LEFT JOIN users rb ON rb.id=q.resolved_by`;
  res.json(isEmployee(req.user) ? await db.all(`${sql} ORDER BY q.id DESC`) : await db.all(`${sql} WHERE q.raised_by=? ORDER BY q.id DESC`, [req.user.id]));
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
app.post('/api/queries/:id/resolve', employee, wrap(async (req, res) => {
  const q = await db.get('SELECT * FROM queries WHERE id=?', [int(req.params.id)]);
  if (!q) return bad(res, 'Not found', 404);
  if (q.status !== 'open') return bad(res, 'Already resolved');
  await db.run(`UPDATE queries SET status='resolved', response=?, resolved_by=?, resolved_at=? WHERE id=?`, [(req.body.response || '').trim() || null, req.user.id, stamp(), q.id]);
  await audit(req, 'resolve_query', 'request', q.request_id, req.body.response || null);
  res.json({ ok: true });
}));

// Service/maintenance complaints: an employee (or admin) raises one with a note and/or a photo;
// staff (or admin) see them all and close them out by attaching a photo of the fix.
const blobReady = () => !!process.env.BLOB_READ_WRITE_TOKEN;
// multer/@vercel/blob are loaded lazily, only for this one route: if either package fails to load
// (version mismatch, bundler quirk) that failure stays contained here instead of crashing the whole app.
let photoUpload;
app.post('/api/maintenance/upload', wrap(async (req, res, next) => {
  if (!blobReady()) return bad(res, 'Photo storage is not configured on the server', 503);
  if (!photoUpload) {
    try {
      const { default: multer } = await import('multer');
      photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
    } catch (e) {
      console.error('Photo upload unavailable, multer failed to load:', e.message);
      return bad(res, 'Photo upload is temporarily unavailable', 503);
    }
  }
  photoUpload.single('photo')(req, res, (err) => err ? next(err) : next());
}), wrap(async (req, res) => {
  if (!req.file) return bad(res, 'No photo provided');
  const sniffed = sniffImageType(req.file.buffer);
  if (!sniffed) return bad(res, 'Only image files are allowed');
  try {
    const { put } = await import('@vercel/blob');
    const blob = await put(`maintenance/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${sniffed.ext}`, req.file.buffer, { access: 'public', contentType: sniffed.mime });
    res.json({ url: blob.url });
  } catch (e) {
    console.error('Blob upload failed:', e.message);
    bad(res, 'Photo upload failed, please try again', 502);
  }
}));
// Identifies the real image type from its magic bytes, since a client-supplied
// Content-Type header can be spoofed to smuggle arbitrary files past an extension check.
function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  return null;
}
const MT_SQL = `SELECT t.*, u.name raised_by_name, u.office raised_by_office, u.email raised_by_email, rb.name resolved_by_name
  FROM maintenance_tickets t LEFT JOIN users u ON u.id=t.raised_by LEFT JOIN users rb ON rb.id=t.resolved_by`;
app.get('/api/maintenance', wrap(async (req, res) => {
  const canSeeAll = ['admin', 'staff'].includes(req.user.role);
  res.json(canSeeAll
    ? await db.all(`${MT_SQL} ORDER BY (t.status='open') DESC, t.id DESC`)
    : await db.all(`${MT_SQL} WHERE t.raised_by=? ORDER BY (t.status='open') DESC, t.id DESC`, [req.user.id]));
}));
app.post('/api/maintenance', employee, wrap(async (req, res) => {
  const note = (req.body.note || '').trim() || null, photoUrl = (req.body.photo_url || '').trim() || null;
  if (!note && !photoUrl) return bad(res, 'Add a note or a photo describing the complaint');
  if (photoUrl && !isHttpUrl(photoUrl)) return bad(res, 'Invalid photo URL');
  const id = await db.insert('INSERT INTO maintenance_tickets (note,photo_url,raised_by,raised_at) VALUES (?,?,?,?)', [note, photoUrl, req.user.id, stamp()]);
  await audit(req, 'create', 'maintenance_ticket', id, note || '(photo only)');
  await notifyMaintenanceOpened({ note, photo_url: photoUrl, raised_by_name: req.user.name, raised_by_office: req.user.office });
  res.status(201).json({ id });
}));
app.post('/api/maintenance/:id/resolve', staffOrAdmin, wrap(async (req, res) => {
  const t = await db.get(`${MT_SQL} WHERE t.id=?`, [int(req.params.id)]);
  if (!t) return bad(res, 'Not found', 404);
  if (t.status !== 'open') return bad(res, 'Already resolved');
  const photoUrl = (req.body.resolution_photo_url || '').trim();
  if (!photoUrl) return bad(res, 'Attach a photo showing the fix to close this complaint');
  if (!isHttpUrl(photoUrl)) return bad(res, 'Invalid photo URL');
  const note = (req.body.resolution_note || '').trim() || null;
  await db.run(`UPDATE maintenance_tickets SET status='resolved', resolution_photo_url=?, resolution_note=?, resolved_by=?, resolved_at=? WHERE id=?`,
    [photoUrl, note, req.user.id, stamp(), t.id]);
  await audit(req, 'resolve', 'maintenance_ticket', t.id, note || null);
  await notifyMaintenanceClosed({ ...t, resolution_photo_url: photoUrl, resolution_note: note }, t.raised_by_email);
  res.json({ ok: true });
}));

// Audit log
app.get('/api/audit', admin, wrap(async (req, res) => {
  const entity = req.query.entity;
  const rows = entity
    ? await db.all('SELECT * FROM audit_log WHERE entity=? ORDER BY id DESC LIMIT 300', [entity])
    : await db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300');
  res.json(rows);
}));

// Users
const ROLES = ['admin', 'employee', 'staff'];
app.get('/api/users', admin, wrap(async (req, res) => res.json(await db.all('SELECT id,name,email,role,office,approved FROM users ORDER BY approved, name'))));
app.post('/api/users/:id/approve', admin, wrap(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', [int(req.params.id)]);
  if (!u) return bad(res, 'User not found', 404);
  if (u.approved) return bad(res, 'Already approved');
  const role = req.body.role || u.role;
  if (!ROLES.includes(role)) return bad(res, 'Invalid role');
  await db.run('UPDATE users SET approved=TRUE, role=? WHERE id=?', [role, u.id]);
  await audit(req, 'approve', 'user', u.id, `${u.email} as ${role}`);
  res.json({ ok: true });
}));
app.put('/api/users/:id/role', admin, wrap(async (req, res) => {
  const id = int(req.params.id), role = req.body.role;
  if (!ROLES.includes(role)) return bad(res, 'Invalid role');
  if (id === req.user.id) return bad(res, "You can't change your own role");
  const u = await db.get('SELECT email,role FROM users WHERE id=?', [id]);
  if (!u) return bad(res, 'User not found', 404);
  await db.run('UPDATE users SET role=? WHERE id=?', [role, id]);
  await audit(req, 'role_change', 'user', id, `${u.email}: ${u.role} → ${role}`);
  res.json({ ok: true });
}));
app.post('/api/users', admin, wrap(async (req, res) => {
  const { name = '', email = '', password = '', role = 'staff', office = '' } = req.body;
  if (!name.trim() || !email.trim() || password.length < 6) return bad(res, 'Name, email and a 6+ character password are required');
  if (!ROLES.includes(role)) return bad(res, 'Invalid role');
  if (!OFFICES.includes(office.trim())) return bad(res, 'Choose a valid office');
  // The admin chose this password, so the user replaces it at first sign-in.
  const id = await db.insert('INSERT INTO users (name,email,password_hash,role,office,must_change_password) VALUES (?,?,?,?,?,TRUE)', [name.trim(), email.trim().toLowerCase(), hashPassword(password), role, office.trim()]);
  await audit(req, 'create', 'user', id, `${email.trim().toLowerCase()} (${role}, ${office.trim()})`);
  res.status(201).json({ ok: true });
}));
app.post('/api/users/:id/password', admin, wrap(async (req, res) => {
  const id = int(req.params.id), password = req.body.password || '';
  if (password.length < 6) return bad(res, 'Password must be at least 6 characters');
  const u = await db.get('SELECT email FROM users WHERE id=?', [id]);
  if (!u) return bad(res, 'User not found', 404);
  await db.run('UPDATE users SET password_hash=?, must_change_password=TRUE WHERE id=?', [hashPassword(password), id]);
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

export default app;

// On Vercel the app runs as a serverless function (api/index.js) and Vercel serves the client itself.
if (!process.env.VERCEL) {
  // Serve built client if present (single-host setup).
  const dist = fileURLToPath(new URL('../client/dist', import.meta.url));
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (req, res) => res.sendFile(dist + '/index.html'));
  }
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API on http://localhost:${port}`));
}
