import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="btn ghost sm icon-only" onClick={onClose} aria-label="Close modal"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Skeleton({ height = 24, width = '100%', radius = 'var(--r-md)' }) {
  return <div className="skeleton" style={{ height, width, borderRadius: radius }} />;
}

export function Alert({ kind = 'error', children }) {
  if (!children) return null;
  const Icon = kind === 'error' ? AlertCircle : CheckCircle2;
  return <div className={`alert ${kind}`} role="alert"><Icon />{children}</div>;
}

export function Field({ label, children }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}

// Counts up from 0 once, when scrolled into view
export function CountUp({ value, duration = 1800 }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(0);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(value); return; }
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || done.current) return;
      done.current = true;
      io.disconnect();
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / duration, 1);
        setShown(Math.round(value * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, [value, duration]);
  return <span ref={ref}>{shown.toLocaleString('en-IN')}</span>;
}

export const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export const inr = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;

// Horizontal bars, scaled to the largest value.
export function BarList({ rows, format = inr, color = '' }) {
  if (!rows?.length) return <p>No data yet.</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label} title={r.label}>
          <span className="name">{r.label}</span>
          <div className="bar-track"><div className={`bar-fill ${color}`} style={{ width: `${Math.max((r.value / max) * 100, 2)}%` }} /></div>
          <span className="val">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

