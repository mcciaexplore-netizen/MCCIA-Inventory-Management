import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Scale, Trash2, Upload } from 'lucide-react';
import { api } from '../api.js';
import { Alert, Field, Modal } from '../components/ui.jsx';
import { FIELDS, buildRows, guessLayout, readGrid } from '../importFile.js';

const blank = { name: '', sku: '', category_id: '', quantity: 0, min_quantity: 0, location: '', notes: '', unit: '', rate: '', vendor: '', vendor_email: '' };

export default function Items({ isAdmin, canManage }) {
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [edit, setEdit] = useState(null);
  const [adj, setAdj] = useState(null);
  const [error, setError] = useState('');
  const [imp, setImp] = useState(null);

  const load = () => Promise.all([api.get('/api/items'), api.get('/api/categories')]).then(([i, c]) => { setItems(i); setCats(c); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => items.filter((i) =>
    (!cat || String(i.category_id) === cat) &&
    `${i.name} ${i.sku || ''} ${i.location || ''} ${i.vendor || ''}`.toLowerCase().includes(q.toLowerCase())), [items, q, cat]);

  async function save(e) {
    e.preventDefault(); setError('');
    try {
      edit.id ? await api.put(`/api/items/${edit.id}`, edit) : await api.post('/api/items', edit);
      setEdit(null); load();
    } catch (err) { setError(err.message); }
  }
  async function remove(i) {
    if (!confirm(`Delete "${i.name}" and its issue history?`)) return;
    try { await api.del(`/api/items/${i.id}`); load(); } catch (err) { setError(err.message); }
  }
  async function adjust(e) {
    e.preventDefault(); setError('');
    try { await api.post(`/api/items/${adj.item.id}/adjust`, { delta: adj.delta, reason: adj.reason, note: adj.note }); setAdj(null); load(); } catch (err) { setError(err.message); }
  }
  async function pickFile(e) {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const grid = await readGrid(file);
      if (!grid.length) throw new Error('No data found in that file');
      setImp({ file: file.name, grid, ...guessLayout(grid), result: null });
    } catch (err) { setError(err.message); }
  }
  async function runImport() {
    setError('');
    try {
      const result = await api.post('/api/items/bulk', { rows: buildRows(imp.grid, imp.header, imp.map) });
      setImp({ ...imp, result }); load();
    } catch (err) { setError(err.message); }
  }
  const set = (k) => (e) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Inventory</span><h1>Items</h1><p>{items.length} item types tracked.</p></div>
        {canManage && <div style={{ display: 'flex', gap: '0.5rem' }}>
          <label className="btn ghost" style={{ cursor: 'pointer' }}><Upload /> Import file<input type="file" accept=".xlsx,.xls,.csv,.pdf" hidden onChange={pickFile} /></label>
          <button className="btn primary" onClick={() => { setError(''); setEdit(blank); }}><Plus /> Add item</button>
        </div>}
      </div>
      {!edit && !imp && <Alert>{error}</Alert>}
      <div className="toolbar reveal">
        <input placeholder="Search name, SKU, vendor or location…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>SKU</th><th>Category</th><th>Vendor</th><th>Rate</th><th>Qty</th>{canManage && <th />}</tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.name}</strong></td>
                  <td>{i.sku || '—'}</td>
                  <td>{i.category ? <span className="chip">{i.category}</span> : '—'}</td>
                  <td>{i.vendor || '—'}</td>
                  <td>{i.rate != null ? `₹${i.rate.toLocaleString('en-IN')}` : '—'}{i.unit ? <span className="label"> / {i.unit}</span> : ''}</td>
                  <td><span className={`badge ${i.quantity === 0 ? 'red' : i.min_quantity > 0 && i.quantity <= i.min_quantity ? '' : 'green'}`}>{i.quantity}{i.min_quantity > 0 && i.quantity <= i.min_quantity ? ' · low' : ''}</span></td>
                  {canManage && <td className="actions">
                    <button className="btn ghost sm" title="Adjust stock" onClick={() => { setError(''); setAdj({ item: i, delta: '', reason: 'Recount', note: '' }); }}><Scale /></button>
                    <button className="btn ghost sm" title="Edit" onClick={() => { setError(''); setEdit(i); }}><Pencil /></button>
                    {isAdmin && <button className="btn danger sm" onClick={() => remove(i)}><Trash2 /></button>}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="empty">No items found.</div>}
        </div>
      </div>
      {imp && (() => {
        const rows = buildRows(imp.grid, imp.header, imp.map);
        const head = imp.grid[imp.header] || [];
        return (
          <Modal title={`Import items: ${imp.file}`} onClose={() => setImp(null)}>
            <Alert>{error}</Alert>
            {imp.result ? (
              <>
                <Alert kind="success">{`${imp.result.created} item(s) added, ${imp.result.skipped.length} skipped (already exist).`}</Alert>
                {imp.result.errors.length > 0 && <Alert>{imp.result.errors.slice(0, 8).join(' | ')}</Alert>}
                <div className="modal-actions"><button className="btn primary" onClick={() => setImp(null)}>Done</button></div>
              </>
            ) : (
              <>
                <p style={{ marginBottom: '1rem' }}>Match each field to a column in your file. Items whose name already exists are skipped; new categories are created automatically. For PDFs, check the preview carefully.</p>
                <div className="form-row">
                  <Field label="Header row">
                    <select value={imp.header} onChange={(e) => setImp({ ...imp, header: Number(e.target.value) })}>
                      {imp.grid.slice(0, 15).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter(Boolean).slice(0, 4).join(', ') || '(empty)'}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="form-row" style={{ flexWrap: 'wrap' }}>
                  {FIELDS.map((f) => (
                    <Field key={f.key} label={f.label + (f.required ? ' *' : '')}>
                      <select value={imp.map[f.key] ?? ''} onChange={(e) => setImp({ ...imp, map: { ...imp.map, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) } })}>
                        <option value="">Not in file</option>
                        {head.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                      </select>
                    </Field>
                  ))}
                </div>
                <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto', margin: '1rem 0' }}>
                  <table>
                    <thead><tr><th>Name</th><th>Category</th><th>Unit</th><th>Rate</th><th>Qty</th><th>Vendor</th></tr></thead>
                    <tbody>{rows.slice(0, 10).map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.category || '—'}</td><td>{r.unit || '—'}</td><td>{r.rate || '—'}</td><td>{r.quantity}</td><td>{r.vendor || '—'}</td></tr>)}</tbody>
                  </table>
                  {rows.length === 0 && <div className="empty">Choose the Item name column to see a preview.</div>}
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn ghost" onClick={() => setImp(null)}>Cancel</button>
                  <button className="btn primary" disabled={!rows.length} onClick={runImport}>Import {rows.length} item(s)</button>
                </div>
              </>
            )}
          </Modal>
        );
      })()}
      {adj && (
        <Modal title={`Adjust stock: ${adj.item.name}`} onClose={() => setAdj(null)}>
          <form onSubmit={adjust}>
            <Alert>{error}</Alert>
            <p style={{ marginBottom: '1rem' }}>Currently <strong>{adj.item.quantity}</strong> in stock. Enter a negative number to remove stock.</p>
            <div className="form-row">
              <Field label="Change (+/−)"><input type="number" required value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} /></Field>
              <Field label="Reason">
                <select value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })}>
                  {['Recount', 'Damage', 'Loss', 'Expired', 'Other'].map((r) => <option key={r}>{r}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Note"><input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></Field>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setAdj(null)}>Cancel</button>
              <button className="btn primary">Apply</button>
            </div>
          </form>
        </Modal>
      )}
      {edit && (
        <Modal title={edit.id ? 'Edit item' : 'Add item'} onClose={() => setEdit(null)}>
          <form onSubmit={save}>
            <Alert>{error}</Alert>
            <Field label="Name"><input required value={edit.name} onChange={set('name')} /></Field>
            <div className="form-row">
              <Field label="SKU"><input value={edit.sku || ''} onChange={set('sku')} placeholder="Auto-generated" /></Field>
              <Field label="Category">
                <select value={edit.category_id || ''} onChange={set('category_id')}>
                  <option value="">None</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="form-row">
              <Field label="Quantity"><input type="number" min="0" required value={edit.quantity} onChange={set('quantity')} /></Field>
              <Field label="Low-stock threshold"><input type="number" min="0" value={edit.min_quantity} onChange={set('min_quantity')} /></Field>
            </div>
            <div className="form-row">
              <Field label="Unit"><input value={edit.unit || ''} onChange={set('unit')} placeholder="Nos, Pkt, Box…" /></Field>
              <Field label="Rate (₹)"><input type="number" min="0" step="0.01" value={edit.rate ?? ''} onChange={set('rate')} /></Field>
            </div>
            <Field label="Vendor"><input value={edit.vendor || ''} onChange={set('vendor')} /></Field>
            <Field label="Vendor email (for purchase orders)"><input type="email" value={edit.vendor_email || ''} onChange={set('vendor_email')} /></Field>
            <Field label="Location"><input value={edit.location || ''} onChange={set('location')} /></Field>
            <Field label="Notes"><textarea rows="2" value={edit.notes || ''} onChange={set('notes')} /></Field>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
