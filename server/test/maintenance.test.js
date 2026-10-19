import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, loginAs } from './helpers.js';

describe('maintenance complaints', () => {
  it('lets an employee raise a complaint with just a note', async () => {
    const employee = await loginAs({ role: 'employee' });
    const res = await auth(request(app).post('/api/maintenance'), employee.token).send({ note: 'AC not cooling in room 3' });
    expect(res.status).toBe(201);
  });

  it('rejects a complaint with neither a note nor a photo', async () => {
    const employee = await loginAs({ role: 'employee' });
    const res = await auth(request(app).post('/api/maintenance'), employee.token).send({});
    expect(res.status).toBe(400);
  });

  it('rejects a staff member raising a complaint (staff resolves, doesn\'t raise)', async () => {
    const staff = await loginAs({ role: 'staff' });
    const res = await auth(request(app).post('/api/maintenance'), staff.token).send({ note: 'Something broken' });
    expect(res.status).toBe(403);
  });

  it('lets staff and admin see every complaint, but an employee only sees their own', async () => {
    const employeeA = await loginAs({ role: 'employee' });
    const employeeB = await loginAs({ role: 'employee' });
    const staff = await loginAs({ role: 'staff' });
    await auth(request(app).post('/api/maintenance'), employeeA.token).send({ note: 'From employee A' });
    await auth(request(app).post('/api/maintenance'), employeeB.token).send({ note: 'From employee B' });

    const seenByStaff = await auth(request(app).get('/api/maintenance'), staff.token);
    expect(seenByStaff.body.length).toBeGreaterThanOrEqual(2);

    const seenByA = await auth(request(app).get('/api/maintenance'), employeeA.token);
    expect(seenByA.body.every((t) => t.raised_by_name === employeeA.name || t.note !== 'From employee B')).toBe(true);
    expect(seenByA.body.some((t) => t.note === 'From employee B')).toBe(false);
  });

  it('lets staff resolve an open complaint by attaching a photo', async () => {
    const employee = await loginAs({ role: 'employee' });
    const staff = await loginAs({ role: 'staff' });
    const created = await auth(request(app).post('/api/maintenance'), employee.token).send({ note: 'Leaking tap' });

    const resolved = await auth(request(app).post(`/api/maintenance/${created.body.id}/resolve`), staff.token)
      .send({ resolution_photo_url: 'https://example.com/fixed.jpg', resolution_note: 'Replaced washer' });
    expect(resolved.status).toBe(200);
  });

  it('refuses to resolve a complaint without a photo', async () => {
    const employee = await loginAs({ role: 'employee' });
    const staff = await loginAs({ role: 'staff' });
    const created = await auth(request(app).post('/api/maintenance'), employee.token).send({ note: 'Broken chair' });

    const res = await auth(request(app).post(`/api/maintenance/${created.body.id}/resolve`), staff.token).send({ resolution_note: 'Will fix tomorrow' });
    expect(res.status).toBe(400);
  });

  it('rejects an employee resolving a complaint (not their role)', async () => {
    const employee = await loginAs({ role: 'employee' });
    const created = await auth(request(app).post('/api/maintenance'), employee.token).send({ note: 'Broken window' });
    const res = await auth(request(app).post(`/api/maintenance/${created.body.id}/resolve`), employee.token).send({ resolution_photo_url: 'https://example.com/x.jpg' });
    expect(res.status).toBe(403);
  });

  it('refuses to resolve an already-resolved complaint twice', async () => {
    const employee = await loginAs({ role: 'employee' });
    const staff = await loginAs({ role: 'staff' });
    const created = await auth(request(app).post('/api/maintenance'), employee.token).send({ note: 'Flickering light' });
    await auth(request(app).post(`/api/maintenance/${created.body.id}/resolve`), staff.token).send({ resolution_photo_url: 'https://example.com/x.jpg' });

    const again = await auth(request(app).post(`/api/maintenance/${created.body.id}/resolve`), staff.token).send({ resolution_photo_url: 'https://example.com/y.jpg' });
    expect(again.status).toBe(400);
  });
});

describe('maintenance photo upload', () => {
  it('returns 503 when blob storage is not configured', async () => {
    const employee = await loginAs({ role: 'employee' });
    const res = await auth(request(app).post('/api/maintenance/upload'), employee.token).attach('photo', Buffer.from('fake'), 'x.jpg');
    expect(res.status).toBe(503);
  });
});
