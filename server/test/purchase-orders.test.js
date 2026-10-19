import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, loginAs, createItem } from './helpers.js';

describe('purchase order lifecycle', () => {
  it('creates a draft PO, then receives it (stock in + purchase recorded)', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 5, rate: 10 });

    const created = await auth(request(app).post('/api/purchase-orders'), employee.token)
      .send({ vendor: 'Natraj Stationers', lines: [{ item_id: item.id, quantity: 20, rate: 9 }] });
    expect(created.status).toBe(201);
    expect(created.body.po_no).toMatch(/^PO-/);

    const received = await auth(request(app).post(`/api/purchase-orders/${created.body.id}/receive`), employee.token)
      .send({ payment_method: 'Cash' });
    expect(received.status).toBe(200);

    const items = await auth(request(app).get('/api/items'), employee.token);
    expect(items.body.find((i) => i.id === item.id).quantity).toBe(25);
  });

  it('refuses to receive the same PO twice', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 5 });
    const created = await auth(request(app).post('/api/purchase-orders'), employee.token)
      .send({ vendor: 'Natraj Stationers', lines: [{ item_id: item.id, quantity: 10, rate: 5 }] });
    await auth(request(app).post(`/api/purchase-orders/${created.body.id}/receive`), employee.token).send({ payment_method: 'Cash' });

    const second = await auth(request(app).post(`/api/purchase-orders/${created.body.id}/receive`), employee.token).send({ payment_method: 'Cash' });
    expect(second.status).toBe(400);
  });

  it('cancels a draft PO and refuses to cancel it again', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 5 });
    const created = await auth(request(app).post('/api/purchase-orders'), employee.token)
      .send({ vendor: 'Natraj Stationers', lines: [{ item_id: item.id, quantity: 10, rate: 5 }] });

    const cancelled = await auth(request(app).post(`/api/purchase-orders/${created.body.id}/cancel`), employee.token).send({});
    expect(cancelled.status).toBe(200);

    const again = await auth(request(app).post(`/api/purchase-orders/${created.body.id}/cancel`), employee.token).send({});
    expect(again.status).toBe(400);
  });

  it('requires a Razorpay payment reference when receiving with that method', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 5 });
    const created = await auth(request(app).post('/api/purchase-orders'), employee.token)
      .send({ vendor: 'Natraj Stationers', lines: [{ item_id: item.id, quantity: 10, rate: 5 }] });

    const res = await auth(request(app).post(`/api/purchase-orders/${created.body.id}/receive`), employee.token).send({ payment_method: 'Razorpay' });
    expect(res.status).toBe(400);
  });
});
