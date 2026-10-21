import { useEffect, useState } from 'react';
import { Ban, FileDown, FilePlus2, PackageCheck, Send, TriangleAlert } from 'lucide-react';
import { api, downloadFile } from '../api.js';
import { Alert, Field, Modal, fmtDate } from '../components/ui.jsx';

const STATUS = { draft: '', sent: '', received: 'green', cancelled: 'red' };
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const blankLine = () => ({ item_id: '', quantity: 1, rate: '' });

export default function PurchaseOrders() {
  const [orders, setOrders] = useState([]);
  const [items, setItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [mail, setMail] = useState(true);
  const [modal, setModal] = useState(null); // {type:'new'|'view'|'send'|'receive', ...}
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = () => Promise.all([api.get('/api/purchase-orders'), api.get('/api/items'), api.get('/api/mail-status'), api.get('/api/vendors')])
    .then(([o, i, m, v]) => { setOrders(o); setItems(i); setMail(m.configured); setVendors(v); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const open = (m) => { setError(''); setModal(m); };
  const close = () => setModal(null);
  async function run(fn, msg) {
    setError(''); setNote('');
    try { await fn(); close(); if (msg) setNote(msg); load(); } catch (err) { setError(err.message); }
  }
  async function view(id) {
    try { open({ type: 'view', ...(await api.get(`/api/purchase-orders/${id}`)) }); } catch (err) { setError(err.message); }
  }
  const viewDocument = (id, poNo) => downloadFile(`/api/purchase-orders/${id}/document`, `${poNo}.docx`).catch((err) => setError(err.message));
  const lowCount = items.filter((i) => i.min_quantity > 0 && i.quantity <= i.min_quantity).length;

  const setLine = (n, k) => (e) => setModal({ ...modal, lines: modal.lines.map((l, i) => {
    if (i !== n) return l;
    const next = { ...l, [k]: e.target.value };
    if (k === 'item_id') {
      const it = items.find((x) => String(x.id) === e.target.value);
      if (it) { next.rate = it.rate ?? ''; if (!modal.vendor) setTimeout(() => setModal((m) => ({ ...m, vendor: m.vendor || it.vendor || '', vendor_email: m.vendor_email || it.vendor_email || '' })), 0); }
    }
    return next;
  }) });
  const set = (k) => (e) => setModal({ ...modal, [k]: e.target.value });

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Stock in</span><h1>Purchase orders</h1><p>Draft orders, email them to vendors, and book them in when delivered.</p></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => run(async () => {
            const r = await api.post('/api/purchase-orders/from-low-stock');
            setNote(r.created.length ? `Drafted ${r.created.join(', ')}` : 'No new low-stock items need ordering');
          })}><TriangleAlert /> Draft POs for low stock{lowCount ? ` (${lowCount})` : ''}</button>
          <button className="btn primary" onClick={() => open({ type: 'new', vendor: '', vendor_email: '', vendor_address: '', vendor_gstin: '', vendor_pan: '', notes: '', lines: [blankLine()] })}><FilePlus2 /> New PO</button>
        </div>
      </div>
      {!modal && <Alert>{error}</Alert>}
      {!modal && <Alert kind="success">{note}</Alert>}
      {!mail && <Alert>Email is not configured on the server (SMTP_HOST / SMTP_USER / SMTP_PASS), so POs can be drafted but not emailed.</Alert>}

      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>PO no.</th><th>Vendor</th><th>Date</th><th>Items</th><th>Total ₹</th><th>Status</th><th /></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><strong>{o.po_no}</strong></td><td>{o.vendor}</td><td>{fmtDate(o.created_at)}</td><td>{o.line_count}</td><td>{inr(o.total)}</td>
                  <td><span className={`badge ${STATUS[o.status]}`}>{o.status}</span></td>
                  <td className="actions">
                    <button className="btn ghost sm" onClick={() => view(o.id)}>Open</button>
                    <button className="btn ghost sm" onClick={() => viewDocument(o.id, o.po_no)}><FileDown /> View PO</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {orders.length === 0 && <div className="empty">No purchase orders yet.</div>}
        </div>
      </div>

      {modal?.type === 'new' && (
        <Modal title="New purchase order" onClose={close}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/purchase-orders', modal), 'Purchase order drafted'); }}>
            <Alert>{error}</Alert>
            {vendors.length > 0 && (
              <Field label="Pick a saved vendor">
                <select value="" onChange={(e) => {
                  const v = vendors.find((x) => String(x.id) === e.target.value);
                  if (v) setModal({ ...modal, vendor: v.name, vendor_email: v.email || '', vendor_address: v.address || '', vendor_gstin: v.gstin || '', vendor_pan: v.pan || '' });
                }}>
                  <option value="">Select a vendor to fill in the details below…</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </Field>
            )}
            <div className="form-row">
              <Field label="Vendor"><input required value={modal.vendor} onChange={set('vendor')} /></Field>
              <Field label="Vendor email"><input type="email" value={modal.vendor_email} onChange={set('vendor_email')} /></Field>
            </div>
            <div className="form-row">
              <Field label="Vendor address (for the PO document)"><input value={modal.vendor_address} onChange={set('vendor_address')} /></Field>
            </div>
            <div className="form-row">
              <Field label="Vendor GSTIN"><input value={modal.vendor_gstin} onChange={set('vendor_gstin')} /></Field>
              <Field label="Vendor PAN"><input value={modal.vendor_pan} onChange={set('vendor_pan')} /></Field>
            </div>
            {modal.lines.map((l, n) => (
              <div className="form-row" key={n}>
                <Field label={n === 0 ? 'Item' : ''}>
                  <select value={l.item_id} onChange={setLine(n, 'item_id')}>
                    <option value="">Select an item…</option>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.quantity} in stock)</option>)}
                  </select>
                </Field>
                <Field label={n === 0 ? 'Qty' : ''}><input type="number" min="1" value={l.quantity} onChange={setLine(n, 'quantity')} /></Field>
                <Field label={n === 0 ? 'Rate ₹' : ''}><input type="number" min="0" step="0.01" value={l.rate} onChange={setLine(n, 'rate')} /></Field>
              </div>
            ))}
            <button type="button" className="btn ghost sm" onClick={() => setModal({ ...modal, lines: [...modal.lines, blankLine()] })}>+ Add line</button>
            <Field label="Notes"><input value={modal.notes} onChange={set('notes')} /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary">Save draft</button></div>
          </form>
        </Modal>
      )}

      {modal?.type === 'view' && (
        <Modal title={`Purchase order ${modal.po_no}`} onClose={close}>
          <div className="po-print">
            <img src="/logo.png" alt="MCCIA" style={{ height: 48 }} />
            <p>To: <strong>{modal.vendor}</strong>{modal.vendor_email && <> · {modal.vendor_email}</>}<br />
              {modal.vendor_address && <>{modal.vendor_address}<br /></>}
              {(modal.vendor_gstin || modal.vendor_pan) && <>{[modal.vendor_gstin && `GSTIN/UIN: ${modal.vendor_gstin}`, modal.vendor_pan && `PAN: ${modal.vendor_pan}`].filter(Boolean).join('    ')}<br /></>}
              Date: {fmtDate(modal.created_at)} · Status: {modal.status}</p>
            <table>
              <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Rate ₹</th><th>Amount ₹</th></tr></thead>
              <tbody>
                {modal.lines.map((l, n) => <tr key={l.id}><td>{n + 1}</td><td>{l.item_name}</td><td>{l.quantity} {l.unit || ''}</td><td>{inr(l.rate)}</td><td>{inr(l.quantity * l.rate)}</td></tr>)}
                <tr><td colSpan="4" style={{ textAlign: 'right' }}><strong>Total</strong></td><td><strong>{inr(modal.total)}</strong></td></tr>
              </tbody>
            </table>
            {modal.notes && <p>{modal.notes}</p>}
          </div>
          <Alert>{error}</Alert>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => viewDocument(modal.id, modal.po_no)}><FileDown /> View PO</button>
            {['draft', 'sent'].includes(modal.status) && <>
              <button className="btn ghost" onClick={() => run(() => api.post(`/api/purchase-orders/${modal.id}/cancel`), 'Order cancelled')}><Ban /> Cancel PO</button>
              <button className="btn ghost" disabled={!mail} onClick={() => open({ ...modal, type: 'send', email: modal.vendor_email || '' })}><Send /> Email vendor</button>
              <button className="btn primary" onClick={() => open({ ...modal, type: 'receive', challan_no: '', payment_method: 'Cash', payment_ref: '' })}><PackageCheck /> Mark received</button>
            </>}
          </div>
        </Modal>
      )}

      {modal?.type === 'send' && (
        <Modal title={`Email ${modal.po_no}`} onClose={close}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => api.post(`/api/purchase-orders/${modal.id}/send`, { email: modal.email }), `${modal.po_no} emailed to ${modal.email}`); }}>
            <Alert>{error}</Alert>
            <Field label="Vendor email"><input type="email" required value={modal.email} onChange={set('email')} /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary">Send</button></div>
          </form>
        </Modal>
      )}

      {modal?.type === 'receive' && (
        <Modal title={`Receive ${modal.po_no}`} onClose={close}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => api.post(`/api/purchase-orders/${modal.id}/receive`, modal), `${modal.po_no} received; stock updated`); }}>
            <Alert>{error}</Alert>
            <p>Adds {modal.lines.length} line(s) to stock and records them as purchases (₹{inr(modal.total)}).</p>
            <Field label="Challan no."><input value={modal.challan_no} onChange={set('challan_no')} /></Field>
            <div className="form-row">
              <Field label="Payment method">
                <select value={modal.payment_method} onChange={set('payment_method')}><option>Cash</option><option>Debit card</option><option>Razorpay</option></select>
              </Field>
              {modal.payment_method !== 'Cash' && (
                <Field label={modal.payment_method === 'Razorpay' ? 'Razorpay payment ID' : 'Card txn / last 4 digits'}>
                  <input required={modal.payment_method === 'Razorpay'} value={modal.payment_ref} onChange={set('payment_ref')} />
                </Field>
              )}
            </div>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary">Confirm received</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
