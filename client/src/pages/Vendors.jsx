import { useEffect, useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import { api } from '../api.js';
import { Alert, Field, Modal } from '../components/ui.jsx';
import { VENDOR_FIELDS, buildRows, guessLayout, readGrid } from '../importFile.js';

const blank = { name: '', email: '', address: '', gstin: '', pan: '' };

export default function Vendors({ isAdmin }) {
  const [vendors, setVendors] = useState([]);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [imp, setImp] = useState(null);
  const load = () => api.get('/api/vendors').then(setVendors).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function add(e) {
    e.preventDefault(); setError('');
    try { await api.post('/api/vendors', form); setForm(blank); load(); } catch (err) { setError(err.message); }
  }
  async function remove(v) {
    if (!confirm(`Delete vendor "${v.name}"?`)) return;
    try { await api.del(`/api/vendors/${v.id}`); load(); } catch (err) { setError(err.message); }
  }
  async function pickFile(e) {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const grid = await readGrid(file);
      if (!grid.length) throw new Error('No data found in that file');
      setImp({ file: file.name, grid, ...guessLayout(grid, VENDOR_FIELDS), result: null });
    } catch (err) { setError(err.message); }
  }
  async function runImport() {
    setError('');
    try {
      const result = await api.post('/api/vendors/bulk', { rows: buildRows(imp.grid, imp.header, imp.map, VENDOR_FIELDS) });
      setImp({ ...imp, result }); load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Purchasing</span><h1>Vendors</h1><p>Keep vendor contact and tax details on hand for drafting purchase orders.</p></div>
        <label className="btn ghost" style={{ cursor: 'pointer' }}><Upload /> Import file<input type="file" accept=".xlsx,.xls,.csv,.pdf" hidden onChange={pickFile} /></label>
      </div>
      {!imp && <Alert>{error}</Alert>}
      <form className="card reveal" onSubmit={add}>
        <div className="form-row">
          <Field label="Name"><input required value={form.name} onChange={set('name')} /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={set('email')} /></Field>
        </div>
        <Field label="Address"><input value={form.address} onChange={set('address')} /></Field>
        <div className="form-row">
          <Field label="GSTIN"><input value={form.gstin} onChange={set('gstin')} /></Field>
          <Field label="PAN"><input value={form.pan} onChange={set('pan')} /></Field>
        </div>
        <div className="modal-actions" style={{ justifyContent: 'flex-end' }}><button className="btn primary"><Plus /> Add vendor</button></div>
      </form>
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Address</th><th>GSTIN</th><th>PAN</th><th /></tr></thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id}>
                  <td><strong>{v.name}</strong></td><td>{v.email || '—'}</td><td>{v.address || '—'}</td><td>{v.gstin || '—'}</td><td>{v.pan || '—'}</td>
                  <td className="actions">{isAdmin && <button className="btn danger sm" onClick={() => remove(v)}><Trash2 /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {vendors.length === 0 && <div className="empty">No vendors yet.</div>}
        </div>
      </div>
      {imp && (() => {
        const rows = buildRows(imp.grid, imp.header, imp.map, VENDOR_FIELDS);
        const head = imp.grid[imp.header] || [];
        return (
          <Modal title={`Import vendors: ${imp.file}`} onClose={() => setImp(null)}>
            <Alert>{error}</Alert>
            {imp.result ? (
              <>
                <Alert kind="success">{`${imp.result.created} vendor(s) added, ${imp.result.skipped.length} skipped (already exist).`}</Alert>
                {imp.result.errors.length > 0 && <Alert>{imp.result.errors.slice(0, 8).join(' | ')}</Alert>}
                <div className="modal-actions"><button className="btn primary" onClick={() => setImp(null)}>Done</button></div>
              </>
            ) : (
              <>
                <p style={{ marginBottom: '1rem' }}>Match each field to a column in your file. Vendors whose name already exists are skipped.</p>
                <div className="form-row">
                  <Field label="Header row">
                    <select value={imp.header} onChange={(e) => setImp({ ...imp, header: Number(e.target.value) })}>
                      {imp.grid.slice(0, 15).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter(Boolean).slice(0, 4).join(', ') || '(empty)'}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="form-row" style={{ flexWrap: 'wrap' }}>
                  {VENDOR_FIELDS.map((f) => (
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
                    <thead><tr><th>Name</th><th>Email</th><th>Address</th><th>GSTIN</th><th>PAN</th></tr></thead>
                    <tbody>{rows.slice(0, 10).map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.email || '—'}</td><td>{r.address || '—'}</td><td>{r.gstin || '—'}</td><td>{r.pan || '—'}</td></tr>)}</tbody>
                  </table>
                  {rows.length === 0 && <div className="empty">Choose the Vendor name column to see a preview.</div>}
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn ghost" onClick={() => setImp(null)}>Cancel</button>
                  <button className="btn primary" disabled={!rows.length} onClick={runImport}>Import {rows.length} vendor(s)</button>
                </div>
              </>
            )}
          </Modal>
        );
      })()}
    </>
  );
}
