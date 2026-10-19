import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert } from '../components/ui.jsx';

const ENTITIES = ['item', 'issue', 'request', 'purchase_order', 'category', 'user', 'month', 'maintenance_ticket'];
const fmt = (s) => new Date(s.replace(' ', 'T')).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function Audit() {
  const [rows, setRows] = useState([]);
  const [entity, setEntity] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/api/audit${entity ? `?entity=${entity}` : ''}`).then(setRows).catch((e) => setError(e.message)); }, [entity]);

  return (
    <>
      <div className="page-head reveal"><div><span className="label">Control</span><h1>Audit Log</h1><p>Latest 300 changes: who did what, and when.</p></div></div>
      <Alert>{error}</Alert>
      <div className="toolbar">
        <select value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">Everything</option>
          {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      <div className="card flush reveal">
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(r.created_at)}</td><td>{r.user_name || '—'}</td>
                  <td><span className="badge">{r.action.replace('_', ' ')}</span></td><td>{r.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">Nothing logged yet.</div>}
        </div>
      </div>
    </>
  );
}
