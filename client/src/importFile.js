// Reads an Excel, CSV or PDF file into a grid (array of rows of cell strings), in the browser.
export async function readGrid(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return pdfGrid(await file.arrayBuffer());
  if (!['xlsx', 'xls', 'csv', 'tsv', 'txt'].includes(ext)) throw new Error('Use an .xlsx, .xls, .csv or .pdf file');
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }).map((r) => r.map((c) => String(c).trim()));
}

async function pdfGrid(buf) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const { items } = await (await doc.getPage(p)).getTextContent();
    const lines = new Map();
    for (const t of items) {
      if (!t.str.trim()) continue;
      const y = Math.round(t.transform[5] / 3);
      (lines.get(y) || lines.set(y, []).get(y)).push({ x: t.transform[4], w: t.width, s: t.str });
    }
    for (const y of [...lines.keys()].sort((a, b) => b - a)) {
      const parts = lines.get(y).sort((a, b) => a.x - b.x);
      const cells = [];
      let end = null;
      for (const t of parts) {
        if (end !== null && t.x - end < 6) cells[cells.length - 1] += (t.x - end > 1 ? ' ' : '') + t.s;
        else cells.push(t.s);
        end = t.x + t.w;
      }
      rows.push(cells.map((c) => c.trim()));
    }
  }
  return rows;
}

export const FIELDS = [
  { key: 'name', label: 'Item name', required: true, match: /^(item|name|description|particulars|product|material)/ },
  { key: 'category', label: 'Category', match: /categor|group|type/ },
  { key: 'unit', label: 'Unit', match: /^(unit|uom)/ },
  { key: 'rate', label: 'Rate (₹)', match: /rate|price|cost/ },
  { key: 'quantity', label: 'Quantity', match: /^(qty|quantity|stock|closing|balance)/ },
  { key: 'min_quantity', label: 'Low-stock threshold', match: /min|reorder|threshold/ },
  { key: 'vendor', label: 'Vendor', match: /vendor|supplier/ },
  { key: 'vendor_email', label: 'Vendor email', match: /e-?mail/ },
  { key: 'location', label: 'Location', match: /location|rack|shelf/ },
  { key: 'notes', label: 'Notes', match: /note|remark/ },
];

export const VENDOR_FIELDS = [
  { key: 'name', label: 'Vendor name', required: true, match: /^(vendor|supplier|name|company)/ },
  { key: 'email', label: 'Email', match: /e-?mail/ },
  { key: 'address', label: 'Address', match: /address/ },
  { key: 'gstin', label: 'GSTIN', match: /gst/ },
  { key: 'pan', label: 'PAN', match: /\bpan\b/ },
];

// Finds the header row (most recognised column titles in the first 15 rows) and guesses the mapping.
export function guessLayout(grid, fields = FIELDS) {
  let best = { row: 0, score: -1, map: {} };
  grid.slice(0, 15).forEach((cells, row) => {
    const map = {};
    cells.forEach((c, i) => {
      const f = fields.find((x) => !(x.key in map) && x.match.test(c.toLowerCase()));
      if (f) map[f.key] = i;
    });
    const score = Object.keys(map).length;
    if (score > best.score) best = { row, score, map };
  });
  return { header: best.row, map: best.map };
}

export function buildRows(grid, header, map, fields = FIELDS) {
  const out = [];
  for (const cells of grid.slice(header + 1)) {
    const r = {};
    for (const f of fields) {
      const i = map[f.key];
      if (i == null || i === '') continue;
      const v = String(cells[i] ?? '').trim();
      r[f.key] = ['rate', 'quantity', 'min_quantity'].includes(f.key) ? v.replace(/[₹,\s]/g, '') : v;
    }
    if (fields.some((f) => f.key === 'quantity')) r.quantity = r.quantity || '0';
    if (r.name && !/^total/i.test(r.name)) out.push(r);
  }
  return out;
}
