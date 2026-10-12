import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Alert } from '../components/ui.jsx';

export default function Categories() {
  const [cats, setCats] = useState([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const load = () => api.get('/api/categories').then(setCats).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault(); setError('');
    try { await api.post('/api/categories', { name }); setName(''); load(); } catch (err) { setError(err.message); }
  }
  async function remove(c) {
    if (!confirm(`Delete category "${c.name}"? Its items will become uncategorised.`)) return;
    try { await api.del(`/api/categories/${c.id}`); load(); } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div className="page-head reveal"><div><span className="label">Organise</span><h1>Categories</h1></div></div>
      <Alert>{error}</Alert>
      <form className="toolbar reveal" onSubmit={add}>
        <input required placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary"><Plus /> Add</button>
      </form>
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Items</th><th /></tr></thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong></td>
                  <td><span className="badge">{c.item_count}</span></td>
                  <td className="actions"><button className="btn danger sm" onClick={() => remove(c)}><Trash2 /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
