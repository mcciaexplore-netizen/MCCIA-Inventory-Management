import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, loginAs } from './helpers.js';

describe('editing a user\'s office', () => {
  it('lets an admin move a user to a different office', async () => {
    const admin = await loginAs({ role: 'admin' });
    const staff = await loginAs({ role: 'staff', office: 'Head Office' });

    const res = await auth(request(app).put(`/api/users/${staff.id}/office`), admin.token).send({ office: 'Bhosari' });
    expect(res.status).toBe(200);

    const users = await auth(request(app).get('/api/users'), admin.token);
    expect(users.body.find((u) => u.id === staff.id).office).toBe('Bhosari');
  });

  it('rejects an office that is not in the known list', async () => {
    const admin = await loginAs({ role: 'admin' });
    const staff = await loginAs({ role: 'staff' });
    const res = await auth(request(app).put(`/api/users/${staff.id}/office`), admin.token).send({ office: 'Nowhere' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-admin changing someone\'s office', async () => {
    const employee = await loginAs({ role: 'employee' });
    const staff = await loginAs({ role: 'staff' });
    const res = await auth(request(app).put(`/api/users/${staff.id}/office`), employee.token).send({ office: 'Bhosari' });
    expect(res.status).toBe(403);
  });
});
