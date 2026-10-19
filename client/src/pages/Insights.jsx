import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, BarList, Trend, inr } from '../components/ui.jsx';

export default function Insights() {
  const [months, setMonths] = useState([]);
  const [month, setMonth] = useState('all');
  const [d, setD] = useState(null);
  const [re, setRe] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/reports/months').then(setMonths).catch((e) => setError(e.message));
    api.get('/api/insights/reorder').then(setRe).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { api.get(`/api/insights?month=${month}`).then(setD).catch((e) => setError(e.message)); }, [month]);

  const buyTotal = re ? re.rows.reduce((t, r) => t + r.cost, 0) : 0;
  const vendors = re ? [...new Set(re.rows.map((r) => r.vendor))] : [];

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Analysis</span><h1>Insights</h1><p>Where stock goes, and what to buy next.</p></div>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="all">All time</option>
          {months.map((m) => <option key={m.month} value={m.month}>{m.label}</option>)}
        </select>
      </div>
      <Alert>{error}</Alert>
      {d && (
        <div className="stack">
          <div className="card reveal">
            <h3 style={{ marginBottom: '0.3rem' }}>Monthly trend</h3>
            <p style={{ marginBottom: '0.5rem' }}>Value issued vs purchased, from the monthly register.</p>
            <Trend rows={d.trend} />
          </div>
          <div className="grid cols-2">
            <div className="card reveal" style={{ '--i': 1 }}>
              <h3 style={{ marginBottom: '1rem' }}>Top consumed items (₹)</h3>
              <BarList rows={d.topItems} />
            </div>
            <div className="card reveal" style={{ '--i': 2 }}>
              <h3 style={{ marginBottom: '1rem' }}>By event / programme (₹)</h3>
              <BarList rows={d.byEvent} color="green" />
            </div>
          </div>
          <div className="card reveal" style={{ '--i': 3 }}>
            <h3 style={{ marginBottom: '0.3rem' }}>By person / hall (₹)</h3>
            <p style={{ marginBottom: '1rem' }}>From logged consumption entries, valued at current rates.</p>
            <BarList rows={d.byPerson} />
          </div>
        </div>
      )}
      {re && (
        <div className="card flush reveal" style={{ marginTop: '1.25rem' }}>
          <div style={{ padding: '1.4rem 1.4rem 0.8rem' }}>
            <h3>Reorder suggestions</h3>
            <p>
              Aims for two months of cover, based on average use in {re.basedOn.join(', ') || 'recorded months'}.
              {re.rows.length > 0 && <> Estimated spend: <strong>{inr(buyTotal)}</strong>.</>}
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Vendor</th><th>In stock</th><th>Avg / month</th><th>Cover</th><th>Suggest</th><th>Est. cost</th></tr></thead>
              <tbody>
                {vendors.map((v) => re.rows.filter((r) => r.vendor === v).map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong></td><td>{r.vendor}</td>
                    <td><span className={`badge ${r.quantity === 0 ? 'red' : ''}`}>{r.quantity}</span></td>
                    <td>{r.avgMonthly || '—'}</td>
                    <td>{r.coverMonths === null ? '—' : `${r.coverMonths} mo`}</td>
                    <td><strong>{r.suggest}</strong> {r.unit || ''}</td>
                    <td>{inr(r.cost)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
            {re.rows.length === 0 && <div className="empty">Nothing needs reordering right now.</div>}
          </div>
        </div>
      )}
    </>
  );
}
