import { useEffect, useState } from 'react';
import { HandHelping, Undo2 } from 'lucide-react';
import { api } from '../api.js';
import { Alert, Field, Modal, fmtDate } from '../components/ui.jsx';

const blank = { item_id: '', quantity: 1, issued_to: '', department: '', event: '' };

export default function Issues() {
  const [issues, setIssues] = useState([]);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const [filter, setFilter] = useState('active');
  const [error, setError] = useState('');

  const load = () => Promise.all([api.get('/api/issues'), api.get('/api/items')]).then(([i, it]) => { setIssues(i); setItems(it); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function issue(e) {
    e.preventDefault(); setError('');
    try { await api.post('/api/issues', form); setForm(null); load(); } catch (err) { setError(err.message); }
  }
  async function ret(i) {
    try { await api.post(`/api/issues/${i.id}/return`); load(); } catch (err) { setError(err.message); }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const shown = issues.filter((i) => filter === 'all' || (!i.returned_at && !i.consumed));

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Tracking</span><h1>Issue / Return</h1><p>Assign items to staff or departments and record returns.</p></div>
        <button className="btn primary" onClick={() => { setError(''); setForm(blank); }}><HandHelping /> Issue item</button>
      </div>
      {!form && <Alert>{error}</Alert>}
      <div className="toolbar reveal">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="active">Currently issued (to return)</option>
          <option value="all">All history</option>
        </select>
      </div>
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Qty</th><th>Issued to</th><th>Event / Dept</th><th>Date</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.item_name}</strong></td>
                  <td>{i.quantity}</td>
                  <td>{i.issued_to}</td>
                  <td>{i.event || i.department || '—'}</td>
                  <td>{fmtDate(i.issued_at)}</td>
                  <td><span className={`badge ${i.returned_at ? 'green' : ''}`}>{i.consumed ? 'Consumed' : i.returned_at ? `Returned ${fmtDate(i.returned_at)}` : 'Issued'}</span></td>
                  <td className="actions">{!i.returned_at && !i.consumed && <button className="btn ghost sm" onClick={() => ret(i)}><Undo2 /> Return</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="empty">Nothing to show.</div>}
        </div>
      </div>
      {form && (
        <Modal title="Issue item" onClose={() => setForm(null)}>
          <form onSubmit={issue}>
            <Alert>{error}</Alert>
            <Field label="Item">
              <select required value={form.item_id} onChange={set('item_id')}>
                <option value="">Select an item…</option>
                {items.map((i) => <option key={i.id} value={i.id} disabled={i.quantity === 0}>{i.name} ({i.quantity} in stock)</option>)}
              </select>
            </Field>
            <div className="form-row">
              <Field label="Quantity"><input type="number" min="1" required value={form.quantity} onChange={set('quantity')} /></Field>
              <Field label="Department"><input value={form.department} onChange={set('department')} /></Field>
            </div>
            <Field label="Event / programme"><input value={form.event} onChange={set('event')} /></Field>
            <Field label="Issued to"><input required value={form.issued_to} onChange={set('issued_to')} placeholder="Person name" /></Field>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn primary">Issue</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
