import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, loginAs, createItem } from './helpers.js';

describe('item CRUD and adjustments', () => {
  it('lets an employee create an item', async () => {
    const employee = await loginAs({ role: 'employee' });
    const res = await auth(request(app).post('/api/items'), employee.token).send({ name: `Stapler ${Date.now()}`, quantity: 5, min_quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(5);
  });

  it('rejects an adjustment that would take stock below zero', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 3 });
    const res = await auth(request(app).post(`/api/items/${item.id}/adjust`), employee.token).send({ delta: -5, reason: 'Damage' });
    expect(res.status).toBe(400);
  });

  it('applies a valid adjustment and records it', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 10 });
    const res = await auth(request(app).post(`/api/items/${item.id}/adjust`), employee.token).send({ delta: -4, reason: 'Loss' });
    expect(res.status).toBe(200);
    const after = await auth(request(app).get('/api/items'), employee.token);
    const updated = after.body.find((i) => i.id === item.id);
    expect(updated.quantity).toBe(6);
  });

  it('refuses to delete an item that has stock history', async () => {
    const admin = await loginAs({ role: 'admin' });
    const item = await createItem({ quantity: 5 });
    await auth(request(app).post(`/api/items/${item.id}/adjust`), admin.token).send({ delta: 1, reason: 'Recount' });
    const res = await auth(request(app).delete(`/api/items/${item.id}`), admin.token);
    expect(res.status).toBe(400);
  });

  it('allows deleting an item with no stock history', async () => {
    const admin = await loginAs({ role: 'admin' });
    const item = await createItem({ quantity: 0 });
    const res = await auth(request(app).delete(`/api/items/${item.id}`), admin.token);
    expect(res.status).toBe(200);
  });
});

describe('concurrent stock issuing cannot oversell', () => {
  it('lets only one of two simultaneous over-the-stock issues succeed', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 5 });

    const issue = () => auth(request(app).post('/api/issues'), employee.token).send({ item_id: item.id, quantity: 5, issued_to: 'Front Desk' });
    const [a, b] = await Promise.all([issue(), issue()]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([201, 400]);
  });
});
