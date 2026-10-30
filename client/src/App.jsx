import { Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ChevronLeft, FileText, HandHelping, History, LayoutDashboard, LogOut, Menu, Package, PackagePlus, Truck, UserCog, Users as UsersIcon, Wrench, X } from 'lucide-react';
import { api } from './api.js';
import { roleLabel } from './roles.js';
const PurchaseOrders = lazy(() => import('./pages/PurchaseOrders.jsx'));
const Requests = lazy(() => import('./pages/Requests.jsx'));
import Login from './pages/Login.jsx';
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Items = lazy(() => import('./pages/Items.jsx'));
const Vendors = lazy(() => import('./pages/Vendors.jsx'));
const Issues = lazy(() => import('./pages/Issues.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Purchases = lazy(() => import('./pages/Purchases.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const Maintenance = lazy(() => import('./pages/Maintenance.jsx'));

// Hub SSO: with VITE_SSO_ENFORCE=true, signed-out users are sent to the Hub instead of the login form.
const SSO_ENFORCE = import.meta.env.VITE_SSO_ENFORCE === 'true';
const HUB_URL = (import.meta.env.VITE_HUB_URL || '').replace(/\/+$/, '');

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  // Auth is a server-set httpOnly cookie, invisible to JS, so the only way to know if a
  // session exists is to ask the server. /api/me covers password and Hub SSO sessions alike.
  useEffect(() => {
    api.get('/api/me').then(setUser).then(() => setReady(true), () => {
      // With SSO enforced, go to the Hub, unless the Hub just sent the user back with an error
      // (?reason=...), which the login page shows instead of bouncing between the two forever.
      const reason = new URLSearchParams(window.location.search).get('reason');
      if (SSO_ENFORCE && HUB_URL && !reason) window.location.assign(`${HUB_URL}/launch/mccia-inventory`);
      else setReady(true);
    });
  }, []);
  useEffect(() => setOpen(false), [loc.pathname]);

  if (!ready) return null;
  if (!user) return <Login onLogin={setUser} />;

  const isAdmin = user.role === 'admin';
  const canManage = isAdmin || user.role === 'employee';
  // SSO sign-out is a full page navigation: the server ends the session, then redirects to the Hub's logout.
  const logout = async () => {
    if (user.sso) return window.location.assign('/api/sso/logout');
    await api.post('/api/logout').catch(() => {}); setUser(null);
  };

  // A default or admin-set password must be replaced before anything else is usable.
  if (user.must_change_password) {
    return (
      <div className="login-page">
        <div className="glow" />
        <div style={{ width: '100%', maxWidth: 480 }}>
          <Suspense fallback={null}><Account user={user} forced onChanged={() => setUser({ ...user, must_change_password: false })} /></Suspense>
          <button className="btn ghost" style={{ marginTop: '1rem' }} onClick={logout}><LogOut /> Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="glow" />
      <div className="topbar">
        <div className="brand" style={{ padding: 0 }}><img src="/logo.png" alt="MCCIA" className="logo" style={{ height: 34 }} /></div>
        <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X /> : <Menu />}</button>
      </div>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        {user.hub_url && <a href={user.hub_url} className="hub-back"><ChevronLeft size={14} /> App Hub</a>}
        <div className="brand"><img src="/logo.png" alt="MCCIA" className="logo" style={{ height: 44 }} /></div>
        <nav className="nav">
          <NavLink to="/" end><LayoutDashboard /> Dashboard</NavLink>
          <NavLink to="/items"><Package /> Items</NavLink>
          {canManage && <NavLink to="/issues"><HandHelping /> Issue / Return</NavLink>}
          <NavLink to="/requests"><HandHelping /> {canManage ? "Requests" : "My Requests"}</NavLink>
          {canManage && <NavLink to="/purchases"><PackagePlus /> Purchases</NavLink>}
          {canManage && <NavLink to="/orders"><FileText /> Purchase Orders</NavLink>}
          {canManage && <NavLink to="/vendors"><Truck /> Vendors</NavLink>}
          <NavLink to="/maintenance"><Wrench /> Maintenance</NavLink>
          {isAdmin && <NavLink to="/users"><UsersIcon /> Users</NavLink>}
          {isAdmin && <NavLink to="/audit"><History /> Audit Log</NavLink>}
        </nav>
        <div className="spacer" />
        <NavLink to="/account" className="user-box" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <UserCog size={14} /> <strong>{user.name}</strong><br /><span className="badge">{roleLabel(user.role)}</span>
        </NavLink>
        <button className="btn ghost" onClick={logout}><LogOut /> Sign out</button>
      </aside>
      <main className="main" key={loc.pathname}>
        <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/items" element={<Items isAdmin={isAdmin} canManage={canManage} />} />
          <Route path="/issues" element={canManage ? <Issues /> : <Navigate to="/" />} />
          <Route path="/orders" element={canManage ? <PurchaseOrders /> : <Navigate to="/" />} />
          <Route path="/requests" element={<Requests canManage={canManage} />} />
          <Route path="/maintenance" element={<Maintenance user={user} />} />
          <Route path="/purchases" element={canManage ? <Purchases /> : <Navigate to="/" />} />
          <Route path="/vendors" element={canManage ? <Vendors isAdmin={isAdmin} /> : <Navigate to="/" />} />
          <Route path="/audit" element={isAdmin ? <Audit /> : <Navigate to="/" />} />
          <Route path="/account" element={<Account user={user} />} />
          <Route path="/users" element={isAdmin ? <Users me={user} /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
