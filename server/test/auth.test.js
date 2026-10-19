import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, createUser, loginAs } from './helpers.js';
import { db, hashPassword } from '../db.js';

describe('login', () => {
  it('rejects wrong password', async () => {
    const u = await createUser({ role: 'staff' });
    const res = await request(app).post('/api/login').send({ email: u.email, password: 'wrong-password', office: u.office });
    expect(res.status).toBe(401);
  });

  it('rejects a correct password with the wrong office', async () => {
    const u = await createUser({ role: 'staff', office: 'Head Office' });
    const res = await request(app).post('/api/login').send({ email: u.email, password: u.password, office: 'Bhosari' });
    expect(res.status).toBe(401);
  });

  it('blocks login for an unapproved account', async () => {
    const email = 'pending-user@mccia.local';
    await db.insert(
      'INSERT INTO users (name,email,password_hash,role,office,approved,must_change_password) VALUES (?,?,?,?,?,FALSE,FALSE)',
      ['Pending', email, hashPassword('password123'), 'staff', 'Head Office'],
    );
    const res = await request(app).post('/api/login').send({ email, password: 'password123', office: 'Head Office' });
    expect(res.status).toBe(403);
  });

  it('locks the account out after 5 failed attempts', async () => {
    const u = await createUser({ role: 'staff' });
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/login').send({ email: u.email, password: 'wrong', office: u.office });
    }
    const res = await request(app).post('/api/login').send({ email: u.email, password: u.password, office: u.office });
    expect(res.status).toBe(429);
  });

  it('succeeds with correct credentials and returns a session token', async () => {
    const u = await createUser({ role: 'staff' });
    const res = await request(app).post('/api/login').send({ email: u.email, password: u.password, office: u.office });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('staff');
  });
});

describe('forced password change', () => {
  it('blocks every endpoint except the account ones until the password is changed', async () => {
    const email = 'must-change@mccia.local';
    await db.insert(
      'INSERT INTO users (name,email,password_hash,role,office,approved,must_change_password) VALUES (?,?,?,?,?,TRUE,TRUE)',
      ['Needs Change', email, hashPassword('password123'), 'staff', 'Head Office'],
    );
    const login = await request(app).post('/api/login').send({ email, password: 'password123', office: 'Head Office' });
    const token = login.body.token;

    const blocked = await auth(request(app).get('/api/items'), token);
    expect(blocked.status).toBe(403);

    const allowed = await auth(request(app).get('/api/me'), token);
    expect(allowed.status).toBe(200);
  });
});

describe('role-gated routes', () => {
  it('rejects a staff user creating a category (admin only)', async () => {
    const staff = await loginAs({ role: 'staff' });
    const res = await auth(request(app).post('/api/categories'), staff.token).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an employee creating a category (admin only)', async () => {
    const employee = await loginAs({ role: 'employee' });
    const res = await auth(request(app).post('/api/categories'), employee.token).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('allows an admin to create a category', async () => {
    const admin = await loginAs({ role: 'admin' });
    const res = await auth(request(app).post('/api/categories'), admin.token).send({ name: `Cat ${Date.now()}` });
    expect(res.status).toBe(201);
  });

  it('rejects a staff user creating an item (employee/admin only)', async () => {
    const staff = await loginAs({ role: 'staff' });
    const res = await auth(request(app).post('/api/items'), staff.token).send({ name: 'Pen', quantity: 1 });
    expect(res.status).toBe(403);
  });
});
