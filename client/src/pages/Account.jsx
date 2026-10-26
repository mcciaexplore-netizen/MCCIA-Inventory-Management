import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Field } from '../components/ui.jsx';
import { roleLabel } from '../roles.js';

export default function Account({ user, forced = false, onChanged }) {
  const [f, setF] = useState({ current_password: '', new_password: '', confirm: '' });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  async function save(e) {
    e.preventDefault(); setError(''); setOk('');
    if (f.new_password !== f.confirm) return setError("New passwords don't match");
    try {
      await api.post('/api/me/password', { current_password: f.current_password, new_password: f.new_password });
      setOk('Password changed. Other devices have been signed out.');
      setF({ current_password: '', new_password: '', confirm: '' });
      onChanged?.();
    } catch (err) { setError(err.message); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <div className="page-head reveal"><div><span className="label">Account</span><h1>{user.name}</h1><p>{user.email} · {roleLabel(user.role)}</p></div></div>
      <form className="card reveal" style={{ maxWidth: 480 }} onSubmit={save}>
        <h3 style={{ marginBottom: '1rem' }}>Change password</h3>
        {forced && <p style={{ marginBottom: '1rem' }}>Your password was set by an admin or is the default one. Choose a new password to continue.</p>}
        <Alert>{error}</Alert>
        <Alert kind="success">{ok}</Alert>
        <Field label="Current password"><input type="password" required value={f.current_password} onChange={set('current_password')} /></Field>
        <Field label="New password"><input type="password" required minLength="6" value={f.new_password} onChange={set('new_password')} /></Field>
        <Field label="Confirm new password"><input type="password" required minLength="6" value={f.confirm} onChange={set('confirm')} /></Field>
        <button className="btn primary">Update password</button>
      </form>
    </>
  );
}
