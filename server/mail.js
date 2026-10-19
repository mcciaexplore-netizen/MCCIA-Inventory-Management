import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const LOGO = fileURLToPath(new URL('./assets/logo.png', import.meta.url));
export const ORG = 'Mahratta Chamber of Commerce, Industries & Agriculture (MCCIA)';

export const mailReady = () => Boolean(process.env.SMTP_HOST);

let transport;
export async function sendMail({ to, cc, subject, html }) {
  if (!mailReady()) throw new Error('Email is not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS on the server)');
  const port = Number(process.env.SMTP_PORT || 587);
  transport ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER, to, cc, subject, html,
    attachments: [{ filename: 'logo.png', path: LOGO, cid: 'mccia-logo' }],
  });
}

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const shell = (title, body) => `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1c2733">
  <img src="cid:mccia-logo" alt="MCCIA" style="height:56px"><h2 style="margin:16px 0 4px">${esc(title)}</h2>${body}
  <p style="color:#6b7785;font-size:12px;margin-top:24px">${esc(ORG)} · Inventory Management System</p></div>`;

// Recipients for internal alerts: ALERT_EMAIL, else admin/employee accounts whose login is a real email address.
export async function alertRecipients() {
  if (process.env.ALERT_EMAIL) return process.env.ALERT_EMAIL.split(',').map((s) => s.trim()).filter(Boolean);
  const rows = await db.all(`SELECT email FROM users WHERE role IN ('admin','employee')`);
  return rows.map((r) => r.email).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e) && !e.endsWith('.local'));
}

export function poEmail(po, lines) {
  const rows = lines.map((l, i) => `<tr><td style="padding:6px;border:1px solid #d8dee5">${i + 1}</td><td style="padding:6px;border:1px solid #d8dee5">${esc(l.item_name)}</td>
    <td style="padding:6px;border:1px solid #d8dee5;text-align:right">${l.quantity} ${esc(l.unit || '')}</td><td style="padding:6px;border:1px solid #d8dee5;text-align:right">₹${inr(l.rate)}</td>
    <td style="padding:6px;border:1px solid #d8dee5;text-align:right">₹${inr(l.quantity * l.rate)}</td></tr>`).join('');
  const total = lines.reduce((a, l) => a + l.quantity * l.rate, 0);
  return shell(`Purchase Order ${po.po_no}`, `<p>To: <strong>${esc(po.vendor)}</strong><br>Date: ${esc(String(po.created_at).slice(0, 10))}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="background:#f0f3f6"><th style="padding:6px;border:1px solid #d8dee5">#</th><th style="padding:6px;border:1px solid #d8dee5">Item</th><th style="padding:6px;border:1px solid #d8dee5">Qty</th><th style="padding:6px;border:1px solid #d8dee5">Rate</th><th style="padding:6px;border:1px solid #d8dee5">Amount</th></tr>${rows}
    <tr><td colspan="4" style="padding:6px;border:1px solid #d8dee5;text-align:right"><strong>Total</strong></td><td style="padding:6px;border:1px solid #d8dee5;text-align:right"><strong>₹${inr(total)}</strong></td></tr></table>
    ${po.notes ? `<p>${esc(po.notes)}</p>` : ''}<p>Please confirm receipt of this order and quote the PO number on your challan / invoice.</p>`);
}

export function lowStockEmail(item) {
  return shell('Low stock alert', `<p><strong>${esc(item.name)}</strong> has dropped to <strong>${item.quantity}</strong> ${esc(item.unit || '')},
    at or below its minimum level of ${item.min_quantity}.</p><p>Open the Purchase Orders page and use "Draft POs for low stock" to reorder.</p>`);
}
