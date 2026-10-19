import { useEffect, useState } from 'react';
import { api, setToken } from '../api.js';
import { Alert, Field } from '../components/ui.jsx';

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', office: '' });
  const [offices, setOffices] = useState([]);
  useEffect(() => {
    api.get('/api/offices').then((o) => { setOffices(o); setForm((f) => ({ ...f, office: f.office || o[0] || '' })); }).catch((e) => setError(e.message));
  }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);
  const [notice, setNotice] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      if (signup) {
        await api.post('/api/register', form);
        setSignup(false); setForm({ ...form, password: '' });
        setNotice('Account created. An admin needs to approve it before you can sign in.');
      } else {
        const { token, user } = await api.post('/api/login', form);
        setToken(token); onLogin(user);
      }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="login-page">
      <div className="glow" />
      <form className="card login-card reveal" onSubmit={submit}>
        <div className="brand"><img src="/logo.png" alt="MCCIA" className="logo" style={{ height: 52 }} /></div>
        <h2 style={{ marginBottom: '0.4rem' }}>{signup ? 'Create account' : 'Welcome back'}</h2>
        <p style={{ marginBottom: '1.5rem' }}>{signup ? 'New accounts get staff access once an admin approves them.' : 'Sign in to manage internal inventory.'}</p>
        <Alert>{error}</Alert>
        <Alert kind="success">{notice}</Alert>
        <Field label="Office"><select required value={form.office} onChange={(e) => setForm({ ...form, office: e.target.value })}>{offices.map((o) => <option key={o} value={o}>{o}</option>)}</select></Field>
        {signup && <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>}
        <Field label="Email"><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Password"><input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
        <p style={{ marginTop: '1rem', textAlign: 'center' }}><a href="#" onClick={(e) => { e.preventDefault(); setSignup(!signup); setError(''); setNotice(''); }}>{signup ? 'Already have an account? Sign in' : 'New here? Create an account'}</a></p>
      </form>
    </div>
  );
}
