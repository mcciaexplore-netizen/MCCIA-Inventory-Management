import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { app, auth, createUser, tokenFromSetCookie } from './helpers.js';
import { db } from '../db.js';

// A throwaway Ed25519 keypair stands in for the Hub's signing key. The public key is set the way the Hub
// hands it out (sso-public.b64): the base64 of the SPKI PEM, on one line.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const PUBLIC_B64 = Buffer.from(PUBLIC_PEM).toString('base64');
const AUDIENCE = 'mccia-inventory';
const ENV_KEYS = ['HUB_SSO_PUBLIC_KEY', 'SSO_AUDIENCE', 'HUB_URL', 'SSO_ENFORCE'];

let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HUB_SSO_PUBLIC_KEY = PUBLIC_B64;
  process.env.SSO_AUDIENCE = AUDIENCE;
  process.env.HUB_URL = 'https://hub.example';
  delete process.env.SSO_ENFORCE;
});
afterEach(() => {
  for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

// Signs a token the way the Hub does (src/lib/sso.ts in Mccia-APPHUB); options override one part to make it bad.
let n = 0;
const hubToken = (claims = {}, { key = privateKey, alg = 'EdDSA', aud = AUDIENCE, iss = 'mccia-app-hub', exp = '60s' } = {}) => {
  const t = new SignJWT({ sub: `hub-${++n}`, email: `sso-${Date.now()}-${n}@mccia.local`, name: 'SSO User', role: 'user', ...claims })
    .setProtectedHeader({ alg, typ: 'JWT', kid: 'hub-1' }).setIssuedAt().setAudience(aud).setIssuer(iss).setJti(crypto.randomUUID());
  return (exp === null ? t : t.setExpirationTime(exp)).sign(key);
};
const callback = async (token) => request(app).get('/api/sso/callback').query({ token: await token });

describe('GET /api/sso/callback', () => {
  it('redirects with reason=config when the key or audience is missing, or the key is not an Ed25519 public key', async () => {
    delete process.env.HUB_SSO_PUBLIC_KEY;
    const res = await callback(hubToken());
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?reason=config');

    process.env.HUB_SSO_PUBLIC_KEY = Buffer.from('not a key').toString('base64');
    expect((await callback(hubToken())).headers.location).toBe('/?reason=config');
  });

  it('accepts the public key as a plain PEM too', async () => {
    process.env.HUB_SSO_PUBLIC_KEY = PUBLIC_PEM;
    expect((await callback(hubToken())).headers.location).toBe('/');
  });

  it('rejects a bad signature, wrong algorithm, audience or issuer, expired or exp-less token', async () => {
    const bad = [
      hubToken({}, { key: crypto.generateKeyPairSync('ed25519').privateKey }),
      hubToken({}, { key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, alg: 'ES256' }),
      hubToken({}, { aud: 'some-other-app' }),
      hubToken({}, { iss: 'someone-else' }),
      hubToken({}, { exp: Math.floor(Date.now() / 1000) - 60 }),
      hubToken({}, { exp: null }),
      'not-a-jwt',
    ];
    for (const t of bad) {
      const res = await callback(t);
      expect(res.headers.location).toBe('/?reason=invalid');
      expect(tokenFromSetCookie(res)).toBeNull();
    }
  });

  it('creates an approved staff user for an unknown email and starts an SSO session', async () => {
    const email = `new-${Date.now()}@mccia.local`;
    const res = await callback(hubToken({ email, name: 'New Person' }));
    expect(res.headers.location).toBe('/');
    const session = tokenFromSetCookie(res);
    expect(session).toBeTruthy();

    const u = await db.get('SELECT * FROM users WHERE email=?', [email]);
    expect(u).toMatchObject({ name: 'New Person', role: 'staff', office: 'Head Office', approved: true, must_change_password: false });

    const me = await auth(request(app).get('/api/sso/me'), session);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ sso: true, email, role: 'staff' });
    // The SSO session works for the regular API too, and /api/me flags it for the client's sign-out.
    expect((await auth(request(app).get('/api/items'), session)).status).toBe(200);
    expect((await auth(request(app).get('/api/me'), session)).body.sso).toBe(true);
  });

  it('accepts the token in a POST body, form-encoded or JSON', async () => {
    for (const send of [(r, token) => r.type('form').send({ token }), (r, token) => r.send({ token })]) {
      const res = await send(request(app).post('/api/sso/callback'), await hubToken());
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
      expect((await auth(request(app).get('/api/sso/me'), tokenFromSetCookie(res))).status).toBe(200);
    }
    const bad = await request(app).post('/api/sso/callback').type('form').send({ token: 'not-a-jwt' });
    expect(bad.headers.location).toBe('/?reason=invalid');
  });

  it('maps the Hub admin role to admin for new users', async () => {
    const email = `admin-${Date.now()}@mccia.local`;
    await callback(hubToken({ email, role: 'admin' }));
    expect((await db.get('SELECT role FROM users WHERE email=?', [email])).role).toBe('admin');
  });

  it('signs in an existing user by email without changing their role or office', async () => {
    const existing = await createUser({ role: 'employee', office: 'Bhosari' });
    const res = await callback(hubToken({ email: existing.email.toUpperCase(), role: 'admin' }));
    const me = await auth(request(app).get('/api/sso/me'), tokenFromSetCookie(res));
    expect(me.body).toMatchObject({ id: existing.id, role: 'employee', office: 'Bhosari' });
  });

  it('keeps an unapproved account blocked', async () => {
    const email = `pending-sso-${Date.now()}@mccia.local`;
    await db.insert("INSERT INTO users (name,email,password_hash,role,office,approved) VALUES ('P',?,'x:y','staff','Head Office',FALSE)", [email]);
    const res = await callback(hubToken({ email }));
    expect(res.headers.location).toBe('/?reason=pending');
    expect(tokenFromSetCookie(res)).toBeNull();
  });
});

describe('GET /api/sso/me', () => {
  it('returns 401 for a password-login session', async () => {
    const u = await createUser();
    const login = await request(app).post('/api/login').send({ email: u.email, password: u.password, office: u.office });
    const res = await auth(request(app).get('/api/sso/me'), tokenFromSetCookie(login));
    expect(res.status).toBe(401);
    expect((await auth(request(app).get('/api/me'), tokenFromSetCookie(login))).body.sso).toBe(false);
  });

  it('returns 401 without a session', async () => {
    expect((await request(app).get('/api/sso/me')).status).toBe(401);
  });
});

describe('GET /api/sso/logout', () => {
  it('ends the session and redirects to the Hub logout', async () => {
    const session = tokenFromSetCookie(await callback(hubToken()));
    const res = await auth(request(app).get('/api/sso/logout'), session);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://hub.example/logout');
    expect((await auth(request(app).get('/api/me'), session)).status).toBe(401);
  });
});

describe('SSO_ENFORCE', () => {
  it('tags unauthenticated API calls with reason=sso_required, leaving public routes and password login alone', async () => {
    process.env.SSO_ENFORCE = 'true';
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe('sso_required');
    expect((await request(app).get('/api/offices')).status).toBe(200);

    const u = await createUser();
    const login = await request(app).post('/api/login').send({ email: u.email, password: u.password, office: u.office });
    expect(login.status).toBe(200);
    expect((await auth(request(app).get('/api/items'), tokenFromSetCookie(login))).status).toBe(200);
  });

  it('leaves the plain 401 when off', async () => {
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(401);
    expect(res.body.reason).toBeUndefined();
  });
});
