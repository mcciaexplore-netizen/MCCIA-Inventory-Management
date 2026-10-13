import ExcelJS from 'exceljs';
import { db, tx, stamp } from './db.js';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const currentMonth = () => stamp().slice(0, 7);

export function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return { start: `${m}-01`, next: `${next}-01` };
}

export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export async function listMonths() {
  const rows = await db.all(`
    SELECT substr(purchased_at,1,7) m FROM purchases UNION SELECT substr(created_at,1,7) FROM adjustments
    UNION SELECT substr(issued_at,1,7) FROM issues UNION SELECT month FROM closed_months`);
  const set = new Set(rows.map((r) => r.m).filter(Boolean));
  set.add(currentMonth());
  const closed = new Map((await db.all('SELECT * FROM closed_months')).map((c) => [c.month, c]));
  return [...set].sort().reverse().map((month) => ({ month, label: monthLabel(month), closed: closed.has(month) }));
}

// Opening/closing are derived from today's quantity by walking movements backwards, so
// every stock change must be recorded as a purchase, adjustment, issue or return.
async function liveRows(month) {
  const { start, next } = monthRange(month);
  const items = await db.all('SELECT i.*, c.name category FROM items i LEFT JOIN categories c ON c.id=i.category_id WHERE i.created_at < ? ORDER BY i.name', [`${next} 00:00:00`]);
  const mv = new Map();
  const get = (id) => { if (!mv.has(id)) mv.set(id, { after: 0, p: 0, pAmt: 0, a: 0, net: 0, challan: new Set() }); return mv.get(id); };

  for (const r of await db.all('SELECT * FROM purchases')) {
    const m = get(r.item_id);
    if (r.purchased_at >= next) m.after += r.quantity;
    else if (r.purchased_at >= start) { m.p += r.quantity; m.pAmt += r.quantity * r.rate; if (r.challan_no) m.challan.add(r.challan_no); }
  }
  for (const r of await db.all('SELECT * FROM adjustments')) {
    const m = get(r.item_id);
    if (r.created_at >= next) m.after += r.delta;
    else if (r.created_at >= start) m.a += r.delta;
  }
  for (const r of await db.all('SELECT * FROM issues')) {
    const m = get(r.item_id);
    if (r.issued_at >= next) m.after -= r.quantity;
    else if (r.issued_at >= start) m.net += r.quantity;
    if (!r.consumed && r.returned_at) {
      if (r.returned_at >= next) m.after += r.quantity;
      else if (r.returned_at >= start) m.net -= r.quantity;
    }
  }

  return items.map((i) => {
    const m = get(i.id);
    const closing = i.quantity - m.after;
    return {
      item_id: i.id, name: i.name, vendor: i.vendor || 'In-house', category: i.category || 'Uncategorised', unit: i.unit,
      rate: i.rate || 0, opening: closing - m.p - m.a + m.net, challan: [...m.challan].join(', '),
      purchased: m.p, purchase_amount: m.pAmt, adjusted: m.a, issued: m.net, closing,
    };
  });
}

const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
const totals = (rows) => ({
  opening: sum(rows, (r) => r.openingAmt), purchase: sum(rows, (r) => r.purchase_amount),
  issued: sum(rows, (r) => r.issuedAmt), closing: sum(rows, (r) => r.closingAmt),
});

export async function buildReport(month) {
  const closed = await db.get('SELECT * FROM closed_months WHERE month=?', [month]);
  const raw = closed ? await db.all('SELECT * FROM month_closings WHERE month=? ORDER BY vendor, category, name', [month]) : await liveRows(month);
  const rows = raw.map((r) => ({
    ...r, openingAmt: r.opening * r.rate, issuedAmt: r.issued * r.rate, closingAmt: r.closing * r.rate,
    purchase_rate: r.purchased ? r.purchase_amount / r.purchased : r.rate,
  }));

  const vendors = new Map();
  for (const r of rows) {
    if (!vendors.has(r.vendor)) vendors.set(r.vendor, new Map());
    const secs = vendors.get(r.vendor);
    if (!secs.has(r.category)) secs.set(r.category, []);
    secs.get(r.category).push(r);
  }
  const out = [...vendors.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([vendor, secs]) => {
    const sections = [...secs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([category, rs]) => ({ category, rows: rs, totals: totals(rs) }));
    return { vendor, sections, totals: totals(sections.flatMap((s) => s.rows)) };
  });
  return { month, label: monthLabel(month), closed: !!closed, closedAt: closed?.closed_at || null, imported: !!closed && closed.closed_by == null, vendors: out, totals: totals(rows) };
}

export async function closeMonth(month, userId) {
  const rows = await liveRows(month);
  await tx(async (t) => {
    await t.run('INSERT INTO closed_months (month,closed_at,closed_by) VALUES (?,?,?)', [month, stamp(), userId]);
    for (const r of rows) {
      await t.run(`INSERT INTO month_closings (month,item_id,name,vendor,category,unit,rate,opening,challan,purchased,purchase_amount,adjusted,issued,closing)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [month, r.item_id, r.name, r.vendor, r.category, r.unit, r.rate, r.opening, r.challan, r.purchased, r.purchase_amount, r.adjusted, r.issued, r.closing]);
    }
  });
  return rows.length;
}

export async function reportWorkbook(month) {
  const rep = await buildReport(month);
  const wb = new ExcelJS.Workbook();
  const money = '#,##0.00';
  const bold = (row) => { row.font = { bold: true }; };
  const fill = (row, argb) => row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; });

  const sum_ws = wb.addWorksheet('Summary');
  sum_ws.addRow([`MCCIA Stock Register - ${rep.label}${rep.closed ? ' (closed)' : ' (open)'}`]).font = { bold: true, size: 14 };
  sum_ws.addRow([]);
  const sh = sum_ws.addRow(['Vendor', 'Opening (Rs.)', 'Purchase (Rs.)', 'Issue (Rs.)', 'Closing (Rs.)']);
  bold(sh); fill(sh, 'FFE2E8F0');
  for (const v of rep.vendors) sum_ws.addRow([v.vendor, v.totals.opening, v.totals.purchase, v.totals.issued, v.totals.closing]);
  const st = sum_ws.addRow(['Total', rep.totals.opening, rep.totals.purchase, rep.totals.issued, rep.totals.closing]);
  bold(st);
  sum_ws.columns = [{ width: 24 }, ...Array(4).fill({ width: 16 })];
  sum_ws.eachRow((r, n) => { if (n > 2) for (let c = 2; c <= 5; c++) r.getCell(c).numFmt = money; });

  const used = new Set(['Summary']);
  for (const v of rep.vendors) {
    let name = v.vendor.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Vendor';
    while (used.has(name)) name = name.slice(0, 28) + '_2';
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.columns = [{ width: 34 }, { width: 8 }, ...Array(13).fill({ width: 11 })];
    ws.addRow([`${v.vendor} - ${rep.label}`]).font = { bold: true, size: 14 };
    for (const s of v.sections) {
      ws.addRow([]);
      ws.addRow([s.category.toUpperCase()]).font = { bold: true, size: 12 };
      const g = ws.addRow(['', '', 'Opening Stock', '', '', 'Purchase', '', '', '', 'Adj.', 'Issue Stock', '', 'Closing Stock', '', '']);
      bold(g); fill(g, 'FFF1F5F9');
      const h = ws.addRow(['DESCRIPTION', 'Unit', 'Qty', 'Rate', 'Amt', 'Challan', 'Qty', 'Rate', 'Amt', 'Qty', 'Qty', 'Amt', 'Qty', 'Rate', 'Amt']);
      bold(h); fill(h, 'FFE2E8F0');
      for (const r of s.rows) {
        const row = ws.addRow([r.name, r.unit || '', r.opening, r.rate, r.openingAmt, r.challan || '', r.purchased || '', r.purchased ? r.purchase_rate : '', r.purchased ? r.purchase_amount : '',
          r.adjusted || '', r.issued || '', r.issued ? r.issuedAmt : '', r.closing, r.rate, r.closingAmt]);
        for (const c of [4, 5, 8, 9, 12, 14, 15]) row.getCell(c).numFmt = money;
      }
      const t = ws.addRow(['Total', '', '', '', s.totals.opening, '', '', '', s.totals.purchase, '', '', s.totals.issued, '', '', s.totals.closing]);
      bold(t);
      for (const c of [5, 9, 12, 15]) t.getCell(c).numFmt = money;
    }
  }
  return wb;
}
