import { db } from './db.js';
import { buildReport, currentMonth, listMonths } from './reports.js';

// Value is quantity × the item's current rate, the same basis as the register.
const VALUE = 'COALESCE(i.rate,0) * s.quantity';

export async function consumption(month) {
  const where = month && month !== 'all' ? "WHERE substr(s.issued_at,1,7) = ?" : '';
  const args = where ? [month] : [];
  const q = (sql) => db.all(sql, args);
  const [byEvent, byPerson, topItems] = await Promise.all([
    q(`SELECT COALESCE(NULLIF(TRIM(s.event),''),'(no event)') label, SUM(${VALUE}) value, SUM(s.quantity) qty, COUNT(*) entries
      FROM issues s JOIN items i ON i.id=s.item_id ${where} GROUP BY label ORDER BY value DESC LIMIT 10`),
    q(`SELECT s.issued_to label, SUM(${VALUE}) value, SUM(s.quantity) qty, COUNT(*) entries
      FROM issues s JOIN items i ON i.id=s.item_id ${where} GROUP BY label ORDER BY value DESC LIMIT 10`),
    q(`SELECT i.name label, i.unit, SUM(s.quantity) qty, SUM(${VALUE}) value
      FROM issues s JOIN items i ON i.id=s.item_id ${where} GROUP BY i.id ORDER BY value DESC, qty DESC LIMIT 10`),
  ]);
  return { byEvent, byPerson, topItems };
}

// Monthly totals come from the register itself, so they match the sheets (not just logged entries).
export async function trend(limit = 12) {
  const months = (await listMonths()).slice(0, limit).reverse();
  return Promise.all(months.map(async ({ month, label }) => {
    const t = (await buildReport(month)).totals;
    return { month, label, issued: Math.round(t.issued), purchases: Math.round(t.purchase) };
  }));
}

// Average monthly use comes from up to the last 3 closed months (or the open month if none are closed yet).
export async function reorder() {
  const months = await listMonths();
  let use = months.filter((m) => m.closed).slice(0, 3);
  if (!use.length) use = months.filter((m) => m.month === currentMonth());
  const issued = new Map();
  for (const m of use) {
    for (const v of (await buildReport(m.month)).vendors) for (const s of v.sections) for (const r of s.rows) {
      if (r.item_id != null) issued.set(r.item_id, (issued.get(r.item_id) || 0) + r.issued);
    }
  }
  const items = await db.all('SELECT i.*, c.name category FROM items i LEFT JOIN categories c ON c.id=i.category_id');
  const out = [];
  for (const i of items) {
    const avg = (issued.get(i.id) || 0) / use.length;
    const belowMin = i.min_quantity > 0 && i.quantity <= i.min_quantity;
    if (avg <= 0 && !belowMin) continue;
    const cover = avg > 0 ? i.quantity / avg : null;
    // Aim for two months of cover (or the minimum level, whichever is larger).
    const target = Math.max(Math.ceil(avg * 2), i.min_quantity);
    const suggest = Math.max(0, target - i.quantity);
    if (!suggest || (cover !== null && cover >= 1 && !belowMin)) continue;
    out.push({
      id: i.id, name: i.name, sku: i.sku, vendor: i.vendor || 'In-house', category: i.category, unit: i.unit,
      quantity: i.quantity, avgMonthly: Math.round(avg * 10) / 10, coverMonths: cover === null ? null : Math.round(cover * 10) / 10,
      suggest, rate: i.rate || 0, cost: suggest * (i.rate || 0),
    });
  }
  out.sort((a, b) => a.vendor.localeCompare(b.vendor) || (a.coverMonths ?? 99) - (b.coverMonths ?? 99));
  return { basedOn: use.map((m) => m.label), rows: out };
}
