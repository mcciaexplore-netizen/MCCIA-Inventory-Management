import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, auth, loginAs, createItem } from './helpers.js';

const currentMonth = () => new Date().toISOString().slice(0, 7);

describe('closed-month enforcement', () => {
  it('blocks a stock adjustment dated inside the just-closed current month', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 10 });

    const close = await auth(request(app).post(`/api/reports/${currentMonth()}/close`), employee.token);
    expect(close.status).toBe(200);

    const adjust = await auth(request(app).post(`/api/items/${item.id}/adjust`), employee.token).send({ delta: 1, reason: 'Recount' });
    expect(adjust.status).toBe(400);
  });

  it('refuses to close the same month twice', async () => {
    const employee = await loginAs({ role: 'employee' });
    await auth(request(app).post(`/api/reports/${currentMonth()}/close`), employee.token);
    const again = await auth(request(app).post(`/api/reports/${currentMonth()}/close`), employee.token);
    expect(again.status).toBe(400);
  });

  it('allows mutations again after reopening the month', async () => {
    const employee = await loginAs({ role: 'employee' });
    const item = await createItem({ quantity: 10 });
    await auth(request(app).post(`/api/reports/${currentMonth()}/close`), employee.token);

    const reopen = await auth(request(app).delete(`/api/reports/${currentMonth()}/close`), employee.token);
    expect(reopen.status).toBe(200);

    const adjust = await auth(request(app).post(`/api/items/${item.id}/adjust`), employee.token).send({ delta: 1, reason: 'Recount' });
    expect(adjust.status).toBe(200);
  });
});
