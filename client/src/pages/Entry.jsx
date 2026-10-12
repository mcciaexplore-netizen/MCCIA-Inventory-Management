import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, X } from 'lucide-react';
import { api } from '../api.js';
import { Alert } from '../components/ui.jsx';

const todayStr = () => new Date().toLocaleDateString('en-CA');
const emptyLines = () => Array.from({ length: 5 }, () => ({ item_id: '', quantity: '' }));

export default function Entry() {
  const [items, setItems] = useState([]);
  const [head, setHead] = useState({ date: todayStr(), issued_to: '', event: '', department: '' });
  const [lines, setLines] = useState(emptyLines());
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api.get('/api/items').then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const byVendor = useMemo(() => {
    const g = {};
    for (const i of items) (g[i.vendor || 'In-house'] ||= []).push(i);
    return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const setLine = (n, k, v) => setLines(lines.map((l, i) => (i === n ? { ...l, [k]: v } : l)));
  const filled = lines.filter((l) => l.item_id || l.quantity);

  async function save(e) {
    e.preventDefault(); setError(''); setOk('');
    try {
      const r = await api.post('/api/issues/batch', { ...head, lines: filled });
      setOk(`Saved ${r.count} item${r.count > 1 ? 's' : ''} for ${head.issued_to}.`);
      setLines(emptyLines()); setHead({ ...head, issued_to: '', event: '', department: '' }); load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Consumption</span><h1>Daily Entry</h1><p>Log everything one person took for an event in one go. Stock is deducted straight away.</p></div>
      </div>
      <Alert>{error}</Alert>
      <Alert kind="success">{ok}</Alert>
      <form className="card reveal" onSubmit={save}>
        <div className="form-row">
          <div className="field"><label>Date</label><input type="date" required max={todayStr()} value={head.date} onChange={(e) => setHead({ ...head, date: e.target.value })} /></div>
          <div className="field"><label>Person / hall</label><input required value={head.issued_to} onChange={(e) => setHead({ ...head, issued_to: e.target.value })} placeholder="e.g. Sandhya, Hall- 7" /></div>
        </div>
        <div className="form-row">
          <div className="field"><label>Event / programme</label><input value={head.event} onChange={(e) => setHead({ ...head, event: e.target.value })} /></div>
          <div className="field"><label>Department</label><input value={head.department} onChange={(e) => setHead({ ...head, department: e.target.value })} /></div>
        </div>
        <div className="label" style={{ margin: '0.5rem 0' }}>Items taken</div>
        {lines.map((l, n) => {
          const it = items.find((i) => String(i.id) === l.item_id);
          return (
            <div key={n} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 36px', gap: '0.6rem', marginBottom: '0.6rem' }}>
              <select value={l.item_id} onChange={(e) => setLine(n, 'item_id', e.target.value)}>
                <option value="">Select item…</option>
                {byVendor.map(([v, list]) => (
                  <optgroup key={v} label={v}>
                    {list.map((i) => <option key={i.id} value={i.id} disabled={i.quantity === 0}>{i.name} ({i.quantity})</option>)}
                  </optgroup>
                ))}
              </select>
              <input type="number" min="1" max={it?.quantity} placeholder="Qty" value={l.quantity} onChange={(e) => setLine(n, 'quantity', e.target.value)} />
              <button type="button" className="btn ghost sm" aria-label="Clear line" onClick={() => setLines(lines.length > 1 ? lines.filter((_, i) => i !== n) : emptyLines())}><X /></button>
            </div>
          );
        })}
        <div className="modal-actions" style={{ justifyContent: 'space-between', marginTop: '1rem' }}>
          <button type="button" className="btn ghost" onClick={() => setLines([...lines, { item_id: '', quantity: '' }])}><Plus /> Add row</button>
          <button className="btn primary" disabled={!filled.length}><Save /> Save entry</button>
        </div>
      </form>
    </>
  );
}
