import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';

describe('registration rate limiting', () => {
  it('blocks registration attempts after the per-IP limit is hit', async () => {
    const attempt = (n) => request(app).post('/api/register').send({ name: 'Flood', email: `flood-${n}@mccia.local`, password: 'password123', office: 'Head Office' });
    for (let i = 0; i < 10; i++) {
      const res = await attempt(i);
      expect(res.status).toBe(202);
    }
    const blocked = await attempt(10);
    expect(blocked.status).toBe(429);
  });
});
