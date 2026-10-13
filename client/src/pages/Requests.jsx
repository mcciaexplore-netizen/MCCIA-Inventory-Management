import { useEffect, useState } from 'react';
import { Check, MessageSquareWarning, PackagePlus, X } from 'lucide-react';
import { api } from '../api.js';
import { Alert, Field, Modal, fmtDate } from '../components/ui.jsx';

const STATUS = { pending: '', fulfilled: 'green', rejected: 'red', cancelled: '' };

export default function Requests({ canManage }) {
  const [reqs, setReqs] = useState([]);
  const [queries, setQueries] = useState([]);
  const [items, setItems] = useState([]);
  const [modal, setModal] = useState(null); // {type:'new'|'query'|'reject'|'resolve', ...}
  const [filter, setFilter] = useState('open');
  const [error, setError] = useState('');

  const load = () => Promise.all([api.get('/api/requests'), api.get('/api/queries'), api.get('/api/items')])
    .then(([r, q, it]) => { setReqs(r); setQueries(q); setItems(it); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function run(fn) {
    setError('');
    try { await fn(); setModal(null); load(); } catch (err) { setError(err.message); }
  }
  const set = (k) => (e) => setModal({ ...modal, [k]: e.target.value });
  const shown = reqs.filter((r) => filter === 'all' || r.status === 'pending' || Number(r.open_queries) > 0);
  const openQueries = queries.filter((q) => q.status === 'open');
  const close = () => setModal(null);
  const open = (m) => { setError(''); setModal(m); };

  return (
    <>
      <div className="page-head reveal">
        <div>
          <span className="label">Tracking</span><h1>{canManage ? 'Item requests' : 'My requests'}</h1>
          <p>{canManage ? 'Fulfil staff requests to issue the stock, or reject them.' : 'Request items; a manager will hand them over.'}</p>
        </div>
        <button className="btn primary" onClick={() => open({ type: 'new', item_id: '', quantity: 1, note: '' })}><PackagePlus /> Request item</button>
      </div>
      {!modal && <Alert>{error}</Alert>}

      {openQueries.length > 0 && (
        <div className="card reveal" style={{ marginBottom: 16 }}>
          <h3><MessageSquareWarning size={16} /> {canManage ? 'Open queries' : 'Your open queries'}</h3>
          {openQueries.map((q) => (
            <div key={q.id} style={{ padding: '8px 0' }}>
              <strong>{q.quantity} × {q.item_name}</strong>{canManage && <> — {q.raised_by_name}</>} <span className="label">{fmtDate(q.created_at)}</span>
              <div>{q.message}</div>
              {canManage && <button className="btn ghost sm" onClick={() => open({ type: 'resolve', id: q.id, response: '' })}>Respond</button>}
            </div>
          ))}
        </div>
      )}

      <div className="toolbar reveal">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="open">Needs attention</option>
          <option value="all">All history</option>
        </select>
      </div>
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Qty</th>{canManage && <th>Requested by</th>}<th>Requested</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.item_name}</strong>{r.note && <div className="label">{r.note}</div>}</td>
                  <td>{r.quantity}{canManage && r.status === 'pending' && <div className="label">{r.stock} in stock</div>}</td>
                  {canManage && <td>{r.requester_name}</td>}
                  <td>{fmtDate(r.requested_at)}</td>
                  <td>
                    <span className={`badge ${STATUS[r.status]}`}>{r.status}</span>
                    {r.status === 'rejected' && r.reject_reason && <div className="label">{r.reject_reason}</div>}
                    {r.status === 'fulfilled' && <div className="label">Given {fmtDate(r.resolved_at)}{r.resolved_by_name ? ` by ${r.resolved_by_name}` : ''}</div>}
                    {Number(r.open_queries) > 0 && <div className="label">Query open</div>}
                  </td>
                  <td className="actions">
                    {canManage && r.status === 'pending' && <>
                      <button className="btn ghost sm" disabled={r.stock < r.quantity} title="Mark as given" onClick={() => run(() => api.post(`/api/requests/${r.id}/fulfill`))}><Check /> Given</button>
                      <button className="btn danger sm" onClick={() => open({ type: 'reject', id: r.id, reason: '' })}><X /> Reject</button>
                    </>}
                    {!canManage && r.status === 'pending' && <button className="btn ghost sm" onClick={() => run(() => api.post(`/api/requests/${r.id}/cancel`))}>Cancel</button>}
                    {!canManage && r.status === 'fulfilled' && !Number(r.open_queries) && <button className="btn ghost sm" onClick={() => open({ type: 'query', id: r.id, message: '' })}>Not received?</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="empty">Nothing to show.</div>}
        </div>
      </div>

      {modal?.type === 'new' && (
        <Modal title="Request item" onClose={close}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/requests', modal)); }}>
            <Alert>{error}</Alert>
            <Field label="Item">
              <select required value={modal.item_id} onChange={set('item_id')}>
                <option value="">Select an item…</option>
                {items.map((i) => <option key={i.id} value={i.id} disabled={i.quantity === 0}>{i.name}{i.quantity === 0 ? ' (out of stock)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Quantity"><input type="number" min="1" required value={modal.quantity} onChange={set('quantity')} /></Field>
            <Field label="Note (optional)"><input value={modal.note} onChange={set('note')} placeholder="Purpose / event" /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary">Send request</button></div>
          </form>
        </Modal>
      )}
      {modal?.type === 'query' && (
        <Modal title="Item not received" onClose={close}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => api.post(`/api/requests/${modal.id}/query`, { message: modal.message })); }}>
            <Alert>{error}</Alert>
            <Field label="What happened?"><textarea required rows="3" value={modal.message} onChange={set('message')} /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary">Raise query</button></div>
          </form>
        </Modal>
      )}
      {modal?.type === 'reject' && (
        <Modal title="Reject request" onClose={close}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => api.post(`/api/requests/${modal.id}/reject`, { reason: modal.reason })); }}>
            <Alert>{error}</Alert>
            <Field label="Reason"><input value={modal.reason} onChange={set('reason')} /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn danger">Reject</button></div>
          </form>
        </Modal>
      )}
      {modal?.type === 'resolve' && (
        <Modal title="Respond to query" onClose={close}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => api.post(`/api/queries/${modal.id}/resolve`, { response: modal.response })); }}>
            <Alert>{error}</Alert>
            <Field label="Response"><textarea rows="3" value={modal.response} onChange={set('response')} /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary">Mark resolved</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
