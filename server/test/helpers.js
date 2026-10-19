import request from 'supertest';
import app from '../index.js';
import { db, hashPassword } from '../db.js';

let counter = 0;
const unique = () => `${Date.now()}-${++counter}-${Math.floor(Math.random() * 1e6)}`;

// Inserts an already-approved, password-set user directly (bypassing the register/approve
// flow and the forced-password-change gate) so each test can get straight to its own scenario.
export async function createUser({ role = 'staff', office = 'Head Office' } = {}) {
  const email = `test-${role}-${unique()}@mccia.local`;
  const password = 'password123';
  const id = await db.insert(
    'INSERT INTO users (name,email,password_hash,role,office,approved,must_change_password) VALUES (?,?,?,?,?,TRUE,FALSE)',
    [`Test ${role}`, email, hashPassword(password), role, office],
  );
  return { id, email, password, office, role };
}

export async function loginAs(opts) {
  const u = await createUser(opts);
  const res = await request(app).post('/api/login').send({ email: u.email, password: u.password, office: u.office });
  if (res.status !== 200) throw new Error(`test login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...u, token: res.body.token };
}

export const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);

export async function createCategory(name = `Category ${unique()}`) {
  return db.insert('INSERT INTO categories (name) VALUES (?)', [name]);
}

export async function createItem({ name = `Item ${unique()}`, quantity = 10, min_quantity = 0, category_id = null, rate = 10, unit = 'Nos', vendor = null, vendor_email = null } = {}) {
  const id = await db.insert(
    'INSERT INTO items (name,category_id,quantity,min_quantity,unit,rate,vendor,vendor_email) VALUES (?,?,?,?,?,?,?,?)',
    [name, category_id, quantity, min_quantity, unit, rate, vendor, vendor_email],
  );
  return db.get('SELECT * FROM items WHERE id=?', [id]);
}

export { app };
