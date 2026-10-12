import { useEffect, useState } from 'react';
import { AlertTriangle, HandHelping, Package, Wallet } from 'lucide-react';
import { api } from '../api.js';
import { Alert, BarList, CountUp, fmtDate } from '../components/ui.jsx';

export default function Dashboard() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/api/dashboard').then(setD).catch((e) => setError(e.message)); }, []);
  if (error) return <Alert>{error}</Alert>;
  if (!d) return null;

  const stats = [
    { label: 'Item types', value: d.totalItems, icon: Package },
    { label: 'Units in stock', value: d.totalUnits, icon: Package, green: true },
    { label: 'On loan', value: d.activeIssues, icon: HandHelping },
    { label: 'Stock value (₹)', value: d.stockValue, icon: Wallet, green: true },
  ];

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Overview</span><h1>Dashboard</h1><p>Live snapshot of MCCIA's internal inventory.</p></div>
      </div>
      <div className="grid cols-4" style={{ marginBottom: '1.5rem' }}>
        {stats.map((s, i) => (
          <div className="stat reveal" style={{ '--i': i }} key={s.label}>
            <div className={`icon-tile ${s.green ? 'green' : ''}`}><s.icon /></div>
            <div className={`num ${s.green ? 'green' : ''}`}><CountUp value={s.value} /></div>
            <div className="label">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="grid cols-2" style={{ marginBottom: '1.25rem' }}>
        <div className="card reveal" style={{ '--i': 4 }}>
          <h3 style={{ marginBottom: '1rem' }}>Stock value by vendor</h3>
          <BarList rows={d.stockByVendor} />
        </div>
        <div className="card reveal" style={{ '--i': 5 }}>
          <h3 style={{ marginBottom: '1rem' }}>Stock value by category</h3>
          <BarList rows={d.stockByCategory} color="green" />
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card hover reveal" style={{ '--i': 6 }}>
          <h3 style={{ marginBottom: '1rem' }}>Low stock alerts</h3>
          {d.lowStock.length === 0 ? <Alert kind="success">All items are sufficiently stocked.</Alert> : d.lowStock.map((i) => (
            <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
              <span><AlertTriangle size={14} color="var(--red)" /> {i.name}</span>
              <span className={`badge ${i.quantity === 0 ? 'red' : ''}`}>{i.quantity} left / min {i.min_quantity}</span>
            </div>
          ))}
        </div>
        <div className="card hover reveal" style={{ '--i': 7 }}>
          <h3 style={{ marginBottom: '1rem' }}>Recent activity</h3>
          {d.recent.length === 0 ? <p>No items issued yet.</p> : d.recent.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
              <span>{r.quantity} × {r.item_name} → <strong>{r.issued_to}</strong></span>
              <span className={`badge ${r.returned_at ? 'green' : ''}`}>{r.consumed ? fmtDate(r.issued_at) : r.returned_at ? 'Returned' : fmtDate(r.issued_at)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
