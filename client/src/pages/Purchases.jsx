import { useEffect, useState } from 'react';
import { PackagePlus } from 'lucide-react';
import { api } from '../api.js';
import { Alert, Field, Modal, fmtDate } from '../components/ui.jsx';

const todayStr = () => new Date().toLocaleDateString('en-CA');
const blank = () => ({ item_id: '', quantity: 1, rate: '', challan_no: '', vendor: '', purchased_at: todayStr(), payment_method: 'Cash', payment_ref: '' });

export default function Purchases() {
  const [rows, setRows] = useState([]);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const load = () => Promise.all([api.get('/api/purchases'), api.get('/api/items')]).then(([p, i]) => { setRows(p); setItems(i); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  function pick(e) {
    const it = items.find((i) => String(i.id) === e.target.value);
    setForm({ ...form, item_id: e.target.value, rate: it?.rate ?? '', vendor: it?.vendor || '' });
  }
  async function save(e) {
    e.preventDefault(); setError('');
    try { await api.post('/api/purchases', form); setForm(null); load(); } catch (err) { setError(err.message); }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const total = form ? (Number(form.quantity) || 0) * (Number(form.rate) || 0) : 0;

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Stock in</span><h1>Purchases</h1><p>Record deliveries against a challan. Stock and the item's rate update automatically.</p></div>
        <button className="btn primary" onClick={() => { setError(''); setForm(blank()); }}><PackagePlus /> Record purchase</button>
      </div>
      {!form && <Alert>{error}</Alert>}
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Item</th><th>Vendor</th><th>Challan</th><th>Qty</th><th>Rate ₹</th><th>Amount ₹</th><th>Payment</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.purchased_at)}</td><td><strong>{p.item_name}</strong></td><td>{p.vendor || '—'}</td><td>{p.challan_no || '—'}</td>
                  <td>{p.quantity} {p.unit || ''}</td><td>{p.rate.toLocaleString('en-IN')}</td><td>{(p.quantity * p.rate).toLocaleString('en-IN')}</td>
                  <td>{p.payment_method || '—'}{p.payment_ref && <div className="label">{p.payment_ref}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">No purchases recorded yet. September's purchases are part of the closed September register.</div>}
        </div>
      </div>
      {form && (
        <Modal title="Record purchase" onClose={() => setForm(null)}>
          <form onSubmit={save}>
            <Alert>{error}</Alert>
            <Field label="Item">
              <select required value={form.item_id} onChange={pick}>
                <option value="">Select an item…</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}{i.vendor ? ` — ${i.vendor}` : ''} ({i.quantity} in stock)</option>)}
              </select>
            </Field>
            <div className="form-row">
              <Field label="Quantity"><input type="number" min="1" required value={form.quantity} onChange={set('quantity')} /></Field>
              <Field label="Rate (₹)"><input type="number" min="0" step="0.01" required value={form.rate} onChange={set('rate')} /></Field>
            </div>
            <div className="form-row">
              <Field label="Challan no."><input value={form.challan_no} onChange={set('challan_no')} /></Field>
              <Field label="Date"><input type="date" required max={todayStr()} value={form.purchased_at} onChange={set('purchased_at')} /></Field>
            </div>
            <Field label="Vendor"><input value={form.vendor} onChange={set('vendor')} /></Field>
            <div className="form-row">
              <Field label="Payment method">
                <select value={form.payment_method} onChange={set('payment_method')}>
                  <option>Cash</option><option>Debit card</option><option>Razorpay</option>
                </select>
              </Field>
              {form.payment_method !== 'Cash' && (
                <Field label={form.payment_method === 'Razorpay' ? 'Razorpay payment ID' : 'Card txn / last 4 digits'}>
                  <input required={form.payment_method === 'Razorpay'} value={form.payment_ref} onChange={set('payment_ref')} placeholder={form.payment_method === 'Razorpay' ? 'pay_XXXXXXXXXXXXXX' : ''} />
                </Field>
              )}
            </div>
            <p style={{ marginBottom: '1rem' }}>Total: <strong>₹{total.toLocaleString('en-IN')}</strong></p>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
