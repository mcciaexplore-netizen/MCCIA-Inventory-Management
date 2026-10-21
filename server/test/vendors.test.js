import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, loginAs } from './helpers.js';

describe('vendors', () => {
  it('lets an employee add a vendor, and lists it for any logged-in user', async () => {
    const employee = await loginAs({ role: 'employee' });
    const staff = await loginAs({ role: 'staff' });
    const name = `Circle Furniture ${Date.now()}`;

    const created = await auth(request(app).post('/api/vendors'), employee.token)
      .send({ name, email: 'ap@circlefurniture.in', address: 'Pune', gstin: '27AAQFC1443D1ZN', pan: 'AAQFC1443D' });
    expect(created.status).toBe(201);

    const list = await auth(request(app).get('/api/vendors'), staff.token);
    expect(list.status).toBe(200);
    expect(list.body.find((v) => v.name === name)).toBeTruthy();
  });

  it('rejects a staff user adding a vendor (employee/admin only)', async () => {
    const staff = await loginAs({ role: 'staff' });
    const res = await auth(request(app).post('/api/vendors'), staff.token).send({ name: `Nope ${Date.now()}` });
    expect(res.status).toBe(403);
  });

  it('requires a vendor name', async () => {
    const employee = await loginAs({ role: 'employee' });
    const res = await auth(request(app).post('/api/vendors'), employee.token).send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('refuses a duplicate vendor name', async () => {
    const employee = await loginAs({ role: 'employee' });
    const name = `Dup Vendor ${Date.now()}`;
    await auth(request(app).post('/api/vendors'), employee.token).send({ name });
    const second = await auth(request(app).post('/api/vendors'), employee.token).send({ name });
    expect(second.status).toBe(409);
  });

  it('bulk-imports vendors, skipping ones that already exist', async () => {
    const employee = await loginAs({ role: 'employee' });
    const existingName = `Existing Vendor ${Date.now()}`;
    await auth(request(app).post('/api/vendors'), employee.token).send({ name: existingName });

    const res = await auth(request(app).post('/api/vendors/bulk'), employee.token).send({
      rows: [
        { name: existingName },
        { name: `Bulk Vendor A ${Date.now()}`, email: 'a@example.com', gstin: '27AAAAA0000A1Z5' },
        { name: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toContain(existingName);
    expect(res.body.errors.length).toBe(1);
  });

  it('rejects a non-admin deleting a vendor, but allows an admin', async () => {
    const employee = await loginAs({ role: 'employee' });
    const admin = await loginAs({ role: 'admin' });
    const created = await auth(request(app).post('/api/vendors'), employee.token).send({ name: `Removable ${Date.now()}` });

    const blocked = await auth(request(app).delete(`/api/vendors/${created.body.id}`), employee.token);
    expect(blocked.status).toBe(403);

    const allowed = await auth(request(app).delete(`/api/vendors/${created.body.id}`), admin.token);
    expect(allowed.status).toBe(200);
  });
});
