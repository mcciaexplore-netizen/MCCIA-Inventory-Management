// Import an MCCIA monthly stationery register (.xlsx) into the app's database
// (DATABASE_URL / Neon if set, otherwise the local embedded database).
//
//   node server/import_stock.js SEPTEMBER-2026.xlsx
//   node server/import_stock.js SEPTEMBER-2026.xlsx --snapshot-only
//
// Items come from the vendor sheets (closing stock, unit, closing rate, vendor).
// Consumption rows become issue history flagged as consumed: stock is NOT deducted
// again because the vendor sheets' closing stock already reflects them.
// The sheet's own figures are stored as a closed (imported) month, which can't be reopened.
// --snapshot-only attaches just the closed month register to items imported earlier.
import ExcelJS from 'exceljs';
import { db, tx, stamp } from './db.js';

// Consumption-sheet column name -> vendor-sheet item name (spellings differ between sheets).
const ALIASES = {
  'Simple Pen': 'Natraj Pen',
  'Photo Paper Pkt 180 GSM': 'Photo Paper',
  'White Board Markar': 'White Board Marker',
  'Lexi Pen Blue': 'Lexi Blue@5.5',
  'Lexi Pen Black': 'Lexi Black',
  'Box file': 'Box File',
  'Seperator Colour': 'File Seppretor',
  'Stepler Pin Small Pkt.': 'Stapler Pin Box Small',
  'Cello Tape 1"': "Cello Tape 1'",
  'A4 Sticker Lable Pkt': 'A 4 Sticker Paper',
  'Push Pin Box': 'Push Pin',
  'Outward Registered': 'Outword Register 6Q',
  'C D Marker (OHP)': 'CD Markar',
  'Flat-Spring File': 'Flat File',
  'Register Small 3Q': 'Resister small 3Q',
  'Note Pad No4': 'Not Pad No. 4',
  'Sketch Pen Pkt.': 'Sketch Pen',
  'Glue Stick 15gm Big': 'Glue Stick',
  'Steel Rubber Scale': 'Steel Scale',
  'High Lighter Green': 'Highlighter',
};
const VENDORS = ['Lotus', 'Dhanlaxmi', 'Modren'];

// Cell value as plain data: formulas give their cached result, rich text its text.
const unwrap = (v) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return unwrap(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
  }
  return v ?? null;
};
// A sheet row as a 0-based array of plain values.
const rowValues = (ws, n) => Array.from({ length: ws.columnCount }, (_, i) => unwrap(ws.getRow(n).getCell(i + 1).value));
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
const num = (v) => (typeof v === 'number' ? v : null);

// cols: 0-based indexes of (name, unit, closing qty, closing rate, opening qty, challan, purchase qty, purchase amt, issue qty);
// challan/purchase indexes are null for sheets without a purchase block.
function vendorRows(ws, vendor, category, start, end, cols) {
  const [nameI, unitI, qtyI, rateI, openI, chI, pqI, paI, issI] = cols;
  const at = (r, i) => (i == null ? null : r[i]);
  const out = [];
  for (let n = start; n <= end; n++) {
    const r = rowValues(ws, n);
    if (!r[nameI] || clean(r[nameI]).toLowerCase() === 'total' || num(r[qtyI]) === null) continue;
    out.push({
      name: clean(r[nameI]), unit: r[unitI] ? clean(r[unitI]) : null, qty: Math.trunc(r[qtyI]), rate: num(r[rateI]), vendor, category,
      opening: Math.trunc(num(r[openI]) || 0), challan: at(r, chI) ? clean(at(r, chI)) : '',
      purchased: Math.trunc(num(at(r, pqI)) || 0), purchase_amount: num(at(r, paI)) || 0, issued: Math.trunc(num(r[issI]) || 0),
    });
  }
  return out;
}

// Store the sheet's own opening/purchase/issue/closing figures as a closed month (imported: closed_by is NULL).
async function writeSnapshot(t, month, items) {
  if (await t.get('SELECT 1 FROM closed_months WHERE month=?', [month])) throw new Error(`${month} is already closed.`);
  await t.run('INSERT INTO closed_months (month,closed_at,closed_by) VALUES (?,?,NULL)', [month, stamp()]);
  for (const it of items) {
    await t.run(`INSERT INTO month_closings (month,item_id,name,vendor,category,unit,rate,opening,challan,purchased,purchase_amount,adjusted,issued,closing)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [month, it.id, it.name, it.vendor, it.category, it.unit, it.rate || 0, it.opening, it.challan, it.purchased, it.purchase_amount, it.issued, it.qty]);
  }
}

// "dd.mm.yy" (or a real date cell) -> "YYYY-MM-DD 00:00:00"
function issueDate(v) {
  if (v instanceof Date) return `${v.toISOString().slice(0, 10)} 00:00:00`;
  const [d, m, y] = String(v).split('.').map(Number);
  if (!d || !m || Number.isNaN(y)) throw new Error(`Unrecognised date in consumption sheet: "${v}"`);
  return `${2000 + y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 00:00:00`;
}

async function main(path, snapshotOnly) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheet = (name) => wb.worksheets.find((w) => w.name.trim().toLowerCase() === name)
    || (() => { throw new Error(`Sheet "${name}" not found`); })();
  const lotus = sheet('lotus'), dhan = sheet('dhanlaxmi'), modren = sheet('modren');

  // (sheet, vendor, category, first row, last row, column indexes): same layout as the paper register.
  const plan = [
    [lotus, 'Lotus', 'Stationery', 4, 25, [1, 2, 16, 17, 3, 6, 7, 9, 13]],
    [dhan, 'Dhanlaxmi', 'Stationery', 5, 18, [0, 1, 11, 12, 2, null, null, null, 8]],
    [modren, 'Modren', 'Stationery', 4, 43, [0, 1, 15, 16, 2, 5, 6, 8, 12]],
    [modren, 'Modren', 'Housekeeping', 49, 72, [0, 1, 15, 16, 2, 5, 6, 8, 12]],
  ];
  const items = plan.flatMap(([ws, ...rest]) => vendorRows(ws, ...rest));
  const monthCell = unwrap(lotus.getCell('B1').value);
  if (!(monthCell instanceof Date)) throw new Error('Lotus!B1 should hold the register month as a date');
  const month = monthCell.toISOString().slice(0, 7);

  const existing = await db.all(`SELECT id FROM items WHERE vendor IN (${VENDORS.map(() => '?').join(',')}) ORDER BY id`, VENDORS);
  if (snapshotOnly) {
    if (existing.length !== items.length) throw new Error('Existing vendor items do not match this workbook; cannot attach the month register.');
    items.forEach((it, i) => { it.id = existing[i].id; });
    await tx((t) => writeSnapshot(t, month, items));
    return `Closed ${month} with ${items.length} register rows.`;
  }
  if (existing.length) throw new Error('Vendor items already imported; aborting to avoid duplicates. (--snapshot-only adds just the month register.)');

  const consumption = wb.worksheets.find((w) => w.name.trim().toLowerCase().startsWith('consumption'));
  if (!consumption) throw new Error('Consumption sheet not found');

  let count = 0;
  await tx(async (t) => {
    const cat = async (name) => {
      await t.run('INSERT INTO categories (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [name]);
      return (await t.get('SELECT id FROM categories WHERE name=?', [name])).id;
    };
    const byName = new Map();
    for (const it of items) {
      const catId = await cat(it.category);
      it.id = await t.insert('INSERT INTO items (name,category_id,quantity,min_quantity,unit,rate,vendor) VALUES (?,?,?,0,?,?,?)',
        [it.name, catId, it.qty, it.unit, it.rate, it.vendor]);
      if (!byName.has(it.name)) byName.set(it.name, []);
      byName.get(it.name).push(it);
    }

    const lookup = async (col) => {
      const target = ALIASES[col] ?? col;
      if (target.includes('@')) { // disambiguate same-name items by rate
        const [n, rate] = target.split('@');
        const hit = (byName.get(n) || []).find((i) => i.rate === Number(rate));
        if (!hit) throw new Error(`No "${n}" item at rate ${rate}`);
        return hit.id;
      }
      if (byName.has(target)) return byName.get(target)[0].id;
      // In-house item with no vendor row (e.g. MCCIA Note Pad): create it with zero tracked stock.
      const catId = await cat('Stationery');
      const id = await t.insert('INSERT INTO items (name,category_id,quantity,min_quantity) VALUES (?,?,0,0)', [col, catId]);
      byName.set(target, [{ id }]);
      return id;
    };

    const header = rowValues(consumption, 2);
    const cols = header.map((n, i) => [i, n]).filter(([i, n]) => i >= 3 && n && clean(n)).map(([i, n]) => [i, clean(n)]);
    let date = null;
    for (let n = 5; n <= consumption.rowCount; n++) {
      const r = rowValues(consumption, n);
      if (r[0]) date = r[0] instanceof Date ? r[0] : clean(r[0]);
      if (date === null || (typeof date === 'string' && date.toUpperCase() === 'TOTAL')) continue;
      const person = r[1] ? clean(r[1]) : null;
      for (const [i, col] of cols) {
        const q = num(r[i]);
        if (!q || !person) continue;
        const when = issueDate(date);
        await t.run('INSERT INTO issues (item_id,quantity,issued_to,event,issued_at,returned_at,consumed) VALUES (?,?,?,?,?,?,1)',
          [await lookup(col), Math.trunc(q), person, r[2] ? clean(r[2]) : null, when, when]);
        count++;
      }
    }
    await writeSnapshot(t, month, items);
  });
  return `Imported ${items.length} items, ${count} consumption records and the closed ${month} register.`;
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || 'SEPTEMBER-2026.xlsx';
try {
  console.log(await main(file, args.includes('--snapshot-only')));
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
