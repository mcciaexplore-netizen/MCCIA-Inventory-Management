import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, loginAs, createItem } from './helpers.js';

describe('staff requests fulfilled by an employee', () => {
  it('decrements stock and records an issue when fulfilled', async () => {
    const staff = await loginAs({ role: 'staff' });
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 10 });

    const created = await auth(request(app).post('/api/requests'), staff.token).send({ item_id: item.id, quantity: 4, note: 'Need for front desk' });
    expect(created.status).toBe(201);

    const fulfilled = await auth(request(app).post(`/api/requests/${created.body.id}/fulfill`), employee.token).send({});
    expect(fulfilled.status).toBe(200);

    const items = await auth(request(app).get('/api/items'), employee.token);
    expect(items.body.find((i) => i.id === item.id).quantity).toBe(6);
  });

  it('refuses to fulfil a request for more than is in stock', async () => {
    const staff = await loginAs({ role: 'staff' });
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 2 });

    const created = await auth(request(app).post('/api/requests'), staff.token).send({ item_id: item.id, quantity: 5 });
    const fulfilled = await auth(request(app).post(`/api/requests/${created.body.id}/fulfill`), employee.token).send({});
    expect(fulfilled.status).toBe(400);
  });

  it('rejects a staff member fulfilling their own request', async () => {
    const staff = await loginAs({ role: 'staff' });
    const item = await createItem({ quantity: 10 });
    const created = await auth(request(app).post('/api/requests'), staff.token).send({ item_id: item.id, quantity: 1 });
    const fulfilled = await auth(request(app).post(`/api/requests/${created.body.id}/fulfill`), staff.token).send({});
    expect(fulfilled.status).toBe(403);
  });

  it('marks a request rejected and leaves stock untouched', async () => {
    const staff = await loginAs({ role: 'staff' });
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 10 });
    const created = await auth(request(app).post('/api/requests'), staff.token).send({ item_id: item.id, quantity: 1 });

    const rejected = await auth(request(app).post(`/api/requests/${created.body.id}/reject`), employee.token).send({ reason: 'Out of budget' });
    expect(rejected.status).toBe(200);

    const items = await auth(request(app).get('/api/items'), employee.token);
    expect(items.body.find((i) => i.id === item.id).quantity).toBe(10);
  });
});
