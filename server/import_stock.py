"""Import an MCCIA monthly stationery register (.xlsx) into inventory.db.

    python server/import_stock.py SEPTEMBER-2026.xlsx

Items come from the vendor sheets (closing stock, unit, closing rate, vendor).
Consumption rows become issue history flagged as consumed: stock is NOT deducted
again because the vendor sheets' closing stock already reflects them.
Use --snapshot-only to attach just the closed month register to items imported earlier.
Needs: pip install openpyxl. Run the server once first so the schema exists.
"""
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import openpyxl

DB = Path(__file__).with_name('inventory.db')

# Consumption-sheet column name -> vendor-sheet item name (spellings differ between sheets).
ALIASES = {
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
}


def clean(s):
    return re.sub(r'\s+', ' ', str(s)).strip()


def num(v):
    return v if isinstance(v, (int, float)) else None


def vendor_rows(ws, vendor, category, start, end, cols):
    """cols: indexes of (name, unit, closing qty, closing rate, opening qty, challan, purchase qty, purchase amt, issue qty);
    challan/purchase indexes are None for sheets without a purchase block."""
    name_i, unit_i, qty_i, rate_i, open_i, ch_i, pq_i, pa_i, iss_i = cols
    at = lambda r, i: r[i] if i is not None else None
    for r in ws.iter_rows(min_row=start, max_row=end, values_only=True):
        name = r[name_i]
        if not name or clean(name).lower() == 'total' or num(r[qty_i]) is None:
            continue
        yield dict(name=clean(name), unit=clean(r[unit_i]) if r[unit_i] else None,
                   qty=int(r[qty_i]), rate=num(r[rate_i]), vendor=vendor, category=category,
                   opening=int(num(r[open_i]) or 0), challan=clean(at(r, ch_i)) if at(r, ch_i) else '',
                   purchased=int(num(at(r, pq_i)) or 0), purchase_amount=float(num(at(r, pa_i)) or 0),
                   issued=int(num(r[iss_i]) or 0))


def write_snapshot(db, month, items):
    """Store the sheet's own opening/purchase/issue/closing figures as a closed month (imported, cannot be reopened)."""
    if db.execute('SELECT 1 FROM closed_months WHERE month=?', (month,)).fetchone():
        sys.exit(f'{month} is already closed.')
    db.execute('INSERT INTO closed_months (month,closed_at,closed_by) VALUES (?,?,NULL)', (month, datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
    for it in items:
        db.execute(
            'INSERT INTO month_closings (month,item_id,name,vendor,category,unit,rate,opening,challan,purchased,purchase_amount,adjusted,issued,closing) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)',
            (month, it['id'], it['name'], it['vendor'], it['category'], it['unit'], it['rate'] or 0, it['opening'],
             it['challan'], it['purchased'], it['purchase_amount'], it['issued'], it['qty']))


def main(path, snapshot_only=False):
    wb = openpyxl.load_workbook(path, data_only=True)
    sheets = {s.strip().lower(): wb[s] for s in wb.sheetnames}
    db = sqlite3.connect(DB)
    db.execute('PRAGMA foreign_keys = ON')
    already = db.execute('SELECT 1 FROM items WHERE vendor IS NOT NULL LIMIT 1').fetchone()
    if already and not snapshot_only:
        sys.exit('Vendor items already imported; aborting to avoid duplicates. (--snapshot-only adds just the month register.)')

    def cat(name):
        db.execute('INSERT OR IGNORE INTO categories (name) VALUES (?)', (name,))
        return db.execute('SELECT id FROM categories WHERE name=?', (name,)).fetchone()[0]

    # (sheet, vendor, category, first row, last row, (name, unit, closing qty, closing rate) column indexes)
    lotus, dhan, modren = sheets['lotus'], sheets['dhanlaxmi'], sheets['modren']
    plan = [
        (lotus, 'Lotus', 'Stationery', 4, 25, (1, 2, 16, 17, 3, 6, 7, 9, 13)),
        (dhan, 'Dhanlaxmi', 'Stationery', 5, 18, (0, 1, 11, 12, 2, None, None, None, 8)),
        (modren, 'Modren', 'Stationery', 4, 43, (0, 1, 15, 16, 2, 5, 6, 8, 12)),
        (modren, 'Modren', 'Housekeeping', 49, 72, (0, 1, 15, 16, 2, 5, 6, 8, 12)),
    ]
    items = []
    for ws, vendor, category, a, b, cols in plan:
        items += list(vendor_rows(ws, vendor, category, a, b, cols))

    month = lotus['B1'].value.strftime('%Y-%m')
    if snapshot_only:
        ids = [r[0] for r in db.execute('SELECT id FROM items WHERE vendor IS NOT NULL ORDER BY id')]
        if len(ids) != len(items):
            sys.exit('Existing vendor items do not match this workbook; cannot attach the month register.')
        for it, i in zip(items, ids):
            it['id'] = i
        write_snapshot(db, month, items)
        db.commit()
        print(f'Closed {month} with {len(items)} register rows.')
        return

    by_name = {}
    for it in items:
        cur = db.execute(
            'INSERT INTO items (name,category_id,quantity,min_quantity,unit,rate,vendor) VALUES (?,?,?,0,?,?,?)',
            (it['name'], cat(it['category']), it['qty'], it['unit'], it['rate'], it['vendor']))
        it['id'] = cur.lastrowid
        by_name.setdefault(it['name'], []).append(it)

    def lookup(col):
        target = ALIASES.get(col, col)
        if '@' in target:  # disambiguate same-name items by rate
            n, rate = target.split('@')
            return next(i for i in by_name[n] if i['rate'] == float(rate))['id']
        hit = by_name.get(target)
        if hit:
            return hit[0]['id']
        # In-house item with no vendor row (e.g. MCCIA Note Pad): create it with zero tracked stock.
        cur = db.execute('INSERT INTO items (name,category_id,quantity,min_quantity) VALUES (?,?,0,0)',
                         (col, cat('Stationery')))
        by_name[target] = [dict(id=cur.lastrowid)]
        return cur.lastrowid

    ws = next(v for k, v in sheets.items() if k.startswith('consumption'))
    rows = list(ws.iter_rows(values_only=True))
    cols = {i: clean(n) for i, n in enumerate(rows[1]) if i >= 3 and n}
    date, count = None, 0
    for r in rows[4:]:
        if r[0]:
            date = clean(r[0])
        if date is None or date.upper() == 'TOTAL':
            continue
        person = clean(r[1]) if r[1] else None
        for i, col in cols.items():
            q = num(r[i]) if i < len(r) else None
            if not q or not person:
                continue
            d, m, y = date.split('.')
            when = datetime(2000 + int(y), int(m), int(d)).strftime('%Y-%m-%d 00:00:00')
            db.execute(
                'INSERT INTO issues (item_id,quantity,issued_to,event,issued_at,returned_at,consumed) VALUES (?,?,?,?,?,?,1)',
                (lookup(col), int(q), person, clean(r[2]) if r[2] else None, when, when))
            count += 1
    write_snapshot(db, month, items)
    db.commit()
    print(f'Imported {len(items)} items, {count} consumption records and the closed {month} register.')


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    main(args[0] if args else 'SEPTEMBER-2026.xlsx', '--snapshot-only' in sys.argv)
