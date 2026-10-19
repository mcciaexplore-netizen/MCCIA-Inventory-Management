import { useEffect, useState } from 'react';
import { Camera, Check, Wrench } from 'lucide-react';
import { api, uploadPhoto } from '../api.js';
import { Alert, Field, Modal, fmtDate } from '../components/ui.jsx';

export default function Maintenance({ user }) {
  const canRaise = user.role === 'admin' || user.role === 'employee';
  const canResolve = user.role === 'admin' || user.role === 'staff';
  const [tickets, setTickets] = useState([]);
  const [modal, setModal] = useState(null); // {type:'new'|'resolve', ...}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/api/maintenance').then(setTickets).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const close = () => setModal(null);
  const open = (m) => { setError(''); setModal(m); };
  const set = (k) => (e) => setModal({ ...modal, [k]: e.target.value });
  const setFile = (k) => (e) => setModal({ ...modal, [k]: e.target.files[0] || null });

  async function raise(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      let photo_url = null;
      if (modal.photo) photo_url = (await uploadPhoto('/api/maintenance/upload', modal.photo)).url;
      await api.post('/api/maintenance', { note: modal.note, photo_url });
      close(); load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function resolve(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      if (!modal.photo) throw new Error('Attach a photo showing the fix');
      const { url } = await uploadPhoto('/api/maintenance/upload', modal.photo);
      await api.post(`/api/maintenance/${modal.id}/resolve`, { resolution_photo_url: url, resolution_note: modal.note });
      close(); load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Facilities</span><h1>Maintenance</h1><p>{canResolve ? 'Service and maintenance complaints raised by staff.' : 'Report a service or maintenance issue.'}</p></div>
        {canRaise && <button className="btn primary" onClick={() => open({ type: 'new', note: '', photo: null })}><Wrench /> Report issue</button>}
      </div>
      {!modal && <Alert>{error}</Alert>}
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Complaint</th>{canResolve && <th>Raised by</th>}<th>Raised</th><th>Status</th><th /></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.note || <span className="label">(no note)</span>}
                    {t.photo_url && <div><a href={t.photo_url} target="_blank" rel="noreferrer" className="label">View photo</a></div>}
                  </td>
                  {canResolve && <td>{t.raised_by_name || '—'}{t.raised_by_office ? <div className="label">{t.raised_by_office}</div> : null}</td>}
                  <td>{fmtDate(t.raised_at)}</td>
                  <td>
                    <span className={`badge ${t.status === 'open' ? 'red' : 'green'}`}>{t.status}</span>
                    {t.status === 'resolved' && (
                      <div className="label">
                        Closed {fmtDate(t.resolved_at)}{t.resolved_by_name ? ` by ${t.resolved_by_name}` : ''}
                        {t.resolution_note ? ` — ${t.resolution_note}` : ''}
                        {t.resolution_photo_url && <> · <a href={t.resolution_photo_url} target="_blank" rel="noreferrer">photo</a></>}
                      </div>
                    )}
                  </td>
                  <td className="actions">
                    {canResolve && t.status === 'open' && (
                      <button className="btn ghost sm" onClick={() => open({ type: 'resolve', id: t.id, note: '', photo: null })}><Check /> Resolve</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tickets.length === 0 && <div className="empty">Nothing reported yet.</div>}
        </div>
      </div>

      {modal?.type === 'new' && (
        <Modal title="Report an issue" onClose={close}>
          <form onSubmit={raise}>
            <Alert>{error}</Alert>
            <Field label="What's the problem?"><textarea rows="3" value={modal.note} onChange={set('note')} placeholder="Describe it, or just attach a photo" /></Field>
            <Field label="Photo (optional)"><input type="file" accept="image/*" onChange={setFile('photo')} /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={busy}>Submit</button></div>
          </form>
        </Modal>
      )}
      {modal?.type === 'resolve' && (
        <Modal title="Close this complaint" onClose={close}>
          <form onSubmit={resolve}>
            <Alert>{error}</Alert>
            <p style={{ marginBottom: '1rem' }}>Attach a photo showing the fix to close this out.</p>
            <Field label="Photo of the fix"><input type="file" accept="image/*" required onChange={setFile('photo')} /></Field>
            <Field label="Note (optional)"><textarea rows="2" value={modal.note} onChange={set('note')} /></Field>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={busy}><Camera /> Close with photo</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
