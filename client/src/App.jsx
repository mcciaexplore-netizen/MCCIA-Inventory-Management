import { Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BarChart3, LineChart, ClipboardList, FileText, FolderTree, HandHelping, History, LayoutDashboard, LogOut, Menu, Package, PackagePlus, UserCog, Users as UsersIcon, X } from 'lucide-react';
import { api, getToken, setToken } from './api.js';
const PurchaseOrders = lazy(() => import('./pages/PurchaseOrders.jsx'));
const Requests = lazy(() => import('./pages/Requests.jsx'));
import Login from './pages/Login.jsx';
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Items = lazy(() => import('./pages/Items.jsx'));
const Categories = lazy(() => import('./pages/Categories.jsx'));
const Issues = lazy(() => import('./pages/Issues.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Purchases = lazy(() => import('./pages/Purchases.jsx'));
const Entry = lazy(() => import('./pages/Entry.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const Insights = lazy(() => import('./pages/Insights.jsx'));

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  useEffect(() => {
    if (getToken()) api.get('/api/me').then(setUser).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);
  useEffect(() => setOpen(false), [loc.pathname]);

  if (!ready) return null;
  if (!user) return <Login onLogin={setUser} />;

  const isAdmin = user.role === 'admin';
  const canManage = isAdmin || user.role === 'manager';
  const logout = async () => { await api.post('/api/logout').catch(() => {}); setToken(null); setUser(null); };

  return (
    <div className="shell">
      <div className="glow" />
      <div className="topbar">
        <div className="brand" style={{ padding: 0 }}><img src="/logo.png" alt="MCCIA" className="logo" style={{ height: 34 }} /></div>
        <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X /> : <Menu />}</button>
      </div>
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><img src="/logo.png" alt="MCCIA" className="logo" style={{ height: 44 }} /></div>
        <nav className="nav">
          <NavLink to="/" end><LayoutDashboard /> Dashboard</NavLink>
          <NavLink to="/items"><Package /> Items</NavLink>
          {canManage && <NavLink to="/entry"><ClipboardList /> Daily Entry</NavLink>}
          {canManage && <NavLink to="/issues"><HandHelping /> Issue / Return</NavLink>}
          <NavLink to="/requests"><HandHelping /> {canManage ? "Requests" : "My Requests"}</NavLink>
          {canManage && <NavLink to="/purchases"><PackagePlus /> Purchases</NavLink>}
          {canManage && <NavLink to="/orders"><FileText /> Purchase Orders</NavLink>}
          <NavLink to="/reports"><BarChart3 /> Monthly Report</NavLink>
          <NavLink to="/insights"><LineChart /> Insights</NavLink>
          {isAdmin && <NavLink to="/categories"><FolderTree /> Categories</NavLink>}
          {isAdmin && <NavLink to="/users"><UsersIcon /> Users</NavLink>}
          {isAdmin && <NavLink to="/audit"><History /> Audit Log</NavLink>}
        </nav>
        <div className="spacer" />
        <NavLink to="/account" className="user-box" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <UserCog size={14} /> <strong>{user.name}</strong><br /><span className="badge">{user.role}</span>
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
          <Route path="/entry" element={canManage ? <Entry /> : <Navigate to="/" />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/reports" element={<Reports isAdmin={canManage} />} />
          <Route path="/purchases" element={canManage ? <Purchases /> : <Navigate to="/" />} />
          <Route path="/audit" element={isAdmin ? <Audit /> : <Navigate to="/" />} />
          <Route path="/account" element={<Account user={user} />} />
          <Route path="/categories" element={isAdmin ? <Categories /> : <Navigate to="/" />} />
          <Route path="/users" element={isAdmin ? <Users me={user} /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
