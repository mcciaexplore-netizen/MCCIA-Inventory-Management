import { useEffect, useState } from 'react';
import { Download, Lock, LockOpen } from 'lucide-react';
import { api, getToken } from '../api.js';
import { Alert, fmtDate } from '../components/ui.jsx';

const inr = (n) => (n ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
const q = (n) => (n ? n.toLocaleString('en-IN') : '—');

export default function Reports({ isAdmin }) {
  const [months, setMonths] = useState([]);
  const [month, setMonth] = useState('');
  const [rep, setRep] = useState(null);
  const [vendor, setVendor] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const loadMonths = () => api.get('/api/reports/months').then((m) => { setMonths(m); setMonth((cur) => cur || m[0]?.month || ''); }).catch((e) => setError(e.message));
  const loadReport = () => month && api.get(`/api/reports/${month}`).then(setRep).catch((e) => setError(e.message));
  useEffect(() => { loadMonths(); }, []);
  useEffect(() => { setVendor(''); loadReport(); }, [month]);

  async function download() {
    setError('');
    try {
      const res = await fetch(`/api/reports/${month}/export`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'), { href: url, download: `MCCIA-Stock-Register-${month}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  }
  async function toggleClose() {
    setError(''); setMsg('');
    const closing = !rep.closed;
    const warn = closing
      ? `Close ${rep.label}? Its figures are frozen and the closing stock becomes next month's opening. No further entries can be dated in this month.`
      : `Reopen ${rep.label}?`;
    if (!confirm(warn)) return;
    try {
      closing ? await api.post(`/api/reports/${month}/close`) : await api.del(`/api/reports/${month}/close`);
      setMsg(closing ? `${rep.label} closed.` : `${rep.label} reopened.`);
      loadMonths(); loadReport();
    } catch (e) { setError(e.message); }
  }

  const vendors = rep ? rep.vendors.filter((v) => !vendor || v.vendor === vendor) : [];

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Register</span><h1>Monthly Report</h1><p>Opening, purchases, issues and closing stock per vendor.</p></div>
        <div className="toolbar" style={{ margin: 0 }}>
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m.month} value={m.month}>{m.label}{m.closed ? ' (closed)' : ''}</option>)}
          </select>
          <button className="btn ghost" onClick={download} disabled={!rep}><Download /> Excel</button>
          {isAdmin && rep && (!rep.imported) && (
            <button className="btn primary" onClick={toggleClose}>{rep.closed ? <><LockOpen /> Reopen</> : <><Lock /> Close month</>}</button>
          )}
        </div>
      </div>
      <Alert>{error}</Alert>
      <Alert kind="success">{msg}</Alert>
      {rep && (
        <>
          <div className="grid cols-4" style={{ marginBottom: '1.5rem' }}>
            {[['Opening', rep.totals.opening], ['Purchases', rep.totals.purchase], ['Issued', rep.totals.issued], ['Closing', rep.totals.closing, true]].map(([l, v, g], i) => (
              <div className="stat reveal" style={{ '--i': i }} key={l}>
                <div className={`num ${g ? 'green' : ''}`} style={{ fontSize: '1.7rem' }}>₹{inr(v)}</div>
                <div className="label">{l}</div>
              </div>
            ))}
          </div>
          <div className="toolbar">
            <span className={`badge ${rep.closed ? 'green' : ''}`}>{rep.closed ? `Closed${rep.closedAt ? ' ' + fmtDate(rep.closedAt) : ''}${rep.imported ? ' · imported' : ''}` : 'Open - live figures'}</span>
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">All vendors</option>
              {rep.vendors.map((v) => <option key={v.vendor}>{v.vendor}</option>)}
            </select>
          </div>
          {vendors.map((v) => v.sections.map((s) => (
            <div className="card flush reveal" key={v.vendor + s.category} style={{ marginBottom: '1.25rem' }}>
              <div style={{ padding: '1.1rem 1.1rem 0.6rem' }}><h3>{v.vendor} <span className="badge" style={{ marginLeft: '0.4rem' }}>{s.category}</span></h3></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Description</th><th>Unit</th><th>Opening</th><th>Challan</th><th>Purchase</th><th>Adj.</th><th>Issue</th><th>Closing</th><th>Rate ₹</th><th>Closing ₹</th></tr></thead>
                  <tbody>
                    {s.rows.map((r) => (
                      <tr key={r.name + r.rate + (r.item_id ?? '')}>
                        <td><strong>{r.name}</strong></td><td>{r.unit || '—'}</td><td>{q(r.opening)}</td><td>{r.challan || '—'}</td>
                        <td>{q(r.purchased)}</td><td>{r.adjusted ? (r.adjusted > 0 ? '+' : '') + r.adjusted : '—'}</td><td>{q(r.issued)}</td>
                        <td><strong>{r.closing.toLocaleString('en-IN')}</strong></td><td>{inr(r.rate)}</td><td>{inr(r.closingAmt)}</td>
                      </tr>
                    ))}
                    <tr style={{ background: 'var(--bg-alt)', fontWeight: 700 }}>
                      <td colSpan="4">Total</td><td colSpan="3">Purchases ₹{inr(s.totals.purchase)} · Issued ₹{inr(s.totals.issued)}</td><td colSpan="2">Opening ₹{inr(s.totals.opening)}</td><td>₹{inr(s.totals.closing)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )))}
          {vendors.length === 0 && <div className="empty">No data for this month.</div>}
        </>
      )}
    </>
  );
}
