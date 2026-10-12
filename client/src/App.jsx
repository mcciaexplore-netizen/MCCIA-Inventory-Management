import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BarChart3, LineChart, Boxes, ClipboardList, FolderTree, HandHelping, History, LayoutDashboard, LogOut, Menu, Package, PackagePlus, UserCog, Users as UsersIcon, X } from 'lucide-react';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Items from './pages/Items.jsx';
import Categories from './pages/Categories.jsx';
import Issues from './pages/Issues.jsx';
import Users from './pages/Users.jsx';
import Reports from './pages/Reports.jsx';
import Purchases from './pages/Purchases.jsx';
import Entry from './pages/Entry.jsx';
import Audit from './pages/Audit.jsx';
import Account from './pages/Account.jsx';
import Insights from './pages/Insights.jsx';

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
  const logout = async () => { await api.post('/api/logout').catch(() => {}); setToken(null); setUser(null); };

  return (
    <div className="shell">
      <div className="glow" />
      <div className="topbar">
        <div className="brand" style={{ padding: 0 }}><Boxes size={22} /> MCCIA Inventory</div>
        <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X /> : <Menu />}</button>
      </div>
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><Boxes size={24} /> MCCIA Inventory</div>
        <nav className="nav">
          <NavLink to="/" end><LayoutDashboard /> Dashboard</NavLink>
          <NavLink to="/items"><Package /> Items</NavLink>
          <NavLink to="/entry"><ClipboardList /> Daily Entry</NavLink>
          <NavLink to="/issues"><HandHelping /> Issue / Return</NavLink>
          {isAdmin && <NavLink to="/purchases"><PackagePlus /> Purchases</NavLink>}
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
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/items" element={<Items isAdmin={isAdmin} />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="/entry" element={<Entry />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/reports" element={<Reports isAdmin={isAdmin} />} />
          <Route path="/purchases" element={isAdmin ? <Purchases /> : <Navigate to="/" />} />
          <Route path="/audit" element={isAdmin ? <Audit /> : <Navigate to="/" />} />
          <Route path="/account" element={<Account user={user} />} />
          <Route path="/categories" element={isAdmin ? <Categories /> : <Navigate to="/" />} />
          <Route path="/users" element={isAdmin ? <Users me={user} /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
