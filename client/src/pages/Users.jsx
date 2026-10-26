import { useEffect, useState } from 'react';
import { Check, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Alert, Field, Modal } from '../components/ui.jsx';
import { roleLabel } from '../roles.js';

const blank = { name: '', email: '', password: '', role: 'staff', office: 'Head Office' };

export default function Users({ me }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(null);
  const [reset, setReset] = useState(null);
  const [error, setError] = useState('');
  const [offices, setOffices] = useState([]);
  useEffect(() => { api.get('/api/offices').then(setOffices).catch(() => {}); }, []);
  const load = () => api.get('/api/users').then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault(); setError('');
    try { await api.post('/api/users', form); setForm(null); load(); } catch (err) { setError(err.message); }
  }
  async function remove(u) {
    if (!confirm(`Delete user ${u.name}?`)) return;
    try { await api.del(`/api/users/${u.id}`); load(); } catch (err) { setError(err.message); }
  }
  async function doReset(e) {
    e.preventDefault(); setError('');
    try { await api.post(`/api/users/${reset.user.id}/password`, { password: reset.password }); setReset(null); } catch (err) { setError(err.message); }
  }
  async function act(fn) {
    setError('');
    try { await fn(); load(); } catch (err) { setError(err.message); }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const pending = users.filter((u) => !u.approved).length;

  return (
    <>
      <div className="page-head reveal">
        <div><span className="label">Access</span><h1>Users</h1>{pending > 0 && <p>{pending} sign-up{pending > 1 ? 's' : ''} waiting for approval.</p>}</div>
        <button className="btn primary" onClick={() => { setError(''); setForm(blank); }}><Plus /> Add user</button>
      </div>
      {!form && !reset && <Alert>{error}</Alert>}
      <div className="card flush reveal" style={{ '--i': 1 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Office</th><th>Role</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong></td><td>{u.email}</td>
                  <td>{u.office}</td>
                  <td>
                    {u.id === me.id ? <span className="badge">{roleLabel(u.role)}</span> : (
                      <select value={u.role} aria-label={`Role for ${u.name}`} onChange={(e) => act(() => api.put(`/api/users/${u.id}/role`, { role: e.target.value }))}>
                        <option value="staff">{roleLabel('staff')}</option><option value="employee">{roleLabel('employee')}</option><option value="admin">{roleLabel('admin')}</option>
                      </select>
                    )}
                    {!u.approved && <span className="badge red" style={{ marginLeft: '0.4rem' }}>pending</span>}
                  </td>
                  <td className="actions">
                    {!u.approved && <button className="btn primary sm" onClick={() => act(() => api.post(`/api/users/${u.id}/approve`))}><Check /> Approve</button>}
                    <button className="btn ghost sm" title="Reset password" onClick={() => { setError(''); setReset({ user: u, password: '' }); }}><KeyRound /></button>
                    {u.id !== me.id && <button className="btn danger sm" onClick={() => remove(u)}><Trash2 /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {reset && (
        <Modal title={`Reset password: ${reset.user.name}`} onClose={() => setReset(null)}>
          <form onSubmit={doReset}>
            <Alert>{error}</Alert>
            <p style={{ marginBottom: '1rem' }}>They will be signed out everywhere and must choose their own password after signing in with this one.</p>
            <Field label="New password"><input type="password" required minLength="6" autoFocus value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} /></Field>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setReset(null)}>Cancel</button>
              <button className="btn primary">Reset</button>
            </div>
          </form>
        </Modal>
      )}
      {form && (
        <Modal title="Add user" onClose={() => setForm(null)}>
          <form onSubmit={save}>
            <Alert>{error}</Alert>
            <Field label="Name"><input required value={form.name} onChange={set('name')} /></Field>
            <Field label="Email"><input type="email" required value={form.email} onChange={set('email')} /></Field>
            <Field label="Office"><select value={form.office} onChange={set('office')}>{offices.map((o) => <option key={o} value={o}>{o}</option>)}</select></Field>
            <div className="form-row">
              <Field label="Password"><input type="password" minLength="6" required value={form.password} onChange={set('password')} /></Field>
              <Field label="Role"><select value={form.role} onChange={set('role')}><option value="staff">{roleLabel('staff')}</option><option value="employee">{roleLabel('employee')}</option><option value="admin">{roleLabel('admin')}</option></select></Field>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn primary">Create</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
