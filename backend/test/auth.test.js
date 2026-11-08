import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { setupTestApp, resetDatabase } from './helpers.js';
import { closePool, query } from '../src/db.js';
import { requireRole } from '../src/modules/auth/auth.middleware.js';
import { errorHandler } from '../src/errors.js';
import { parseProfessors, seedProfessors } from '../scripts/seed-professors.js';

let app;
before(async () => {
  app = await setupTestApp();
});
beforeEach(resetDatabase);
after(closePool);

const ana = { name: 'Ana', email: 'Ana@Example.com', password: 'correct-horse-battery' };

function register(body = ana) {
  return request(app).post('/auth/register').send(body);
}
function login(email = ana.email, password = ana.password) {
  return request(app).post('/auth/login').send({ email, password });
}
// The refresh cookie as a "name=value" string, ready to send back.
function refreshCookie(res) {
  const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith('refresh_token='));
  return header && header.split(';')[0];
}

// ---- register ----

test('register creates a student, lowercases the email, hides the password hash', async () => {
  const res = await register();
  assert.equal(res.status, 201);
  assert.equal(res.body.email, 'ana@example.com');
  assert.equal(res.body.role, 'STUDENT');
  assert.deepEqual(Object.keys(res.body).sort(), ['email', 'id', 'name', 'role']);

  const { rows } = await query('SELECT password_hash FROM users');
  assert.match(rows[0].password_hash, /^\$2[aby]\$/, 'stored value is a bcrypt hash');
  assert.notEqual(rows[0].password_hash, ana.password);
});

test('register ignores a role in the body: professors cannot sign up', async () => {
  const res = await register({ ...ana, role: 'PROFESSOR' });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'STUDENT');
});

test('register rejects the same email in different capitals with 409', async () => {
  assert.equal((await register()).status, 201);
  const res = await register({ ...ana, email: 'ANA@example.COM' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'email already registered' });
});

test('register validates fields with 400 {"error"}', async () => {
  const cases = [
    [{ ...ana, email: 'not-an-email' }, 'email is not valid'],
    [{ ...ana, password: 'short' }, 'password must be at least 8 characters'],
    [{ ...ana, password: 'é'.repeat(40) }, 'password must be at most 72 bytes'], // 80 bytes
    [{ email: ana.email, password: ana.password }, 'name is required'],
  ];
  for (const [body, message] of cases) {
    const res = await register(body);
    assert.equal(res.status, 400, message);
    assert.deepEqual(res.body, { error: message });
  }
});

// ---- login ----

test('login returns a token and sets an httpOnly refresh cookie on /auth', async () => {
  await register();
  const res = await login('ana@EXAMPLE.com');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.expiresIn, 900);
  assert.equal(res.body.user.role, 'STUDENT');
  assert.equal(res.body.refreshToken, undefined, 'refresh token must not be in the body');

  const cookie = res.headers['set-cookie'].find((c) => c.startsWith('refresh_token='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/auth/);
  assert.match(cookie, /SameSite=Strict/);
});

test('login gives the same 401 for a wrong password and an unknown email', async () => {
  await register();
  const wrongPassword = await login(ana.email, 'wrong-password');
  const unknownEmail = await login('nobody@example.com', ana.password);
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(wrongPassword.body, unknownEmail.body);
});

// ---- refresh and logout ----

test('refresh rotates: new token works, old token is refused', async () => {
  await register();
  const first = refreshCookie(await login());

  const res = await request(app).post('/auth/refresh').set('Cookie', first);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  const second = refreshCookie(res);
  assert.notEqual(second, first);

  assert.equal((await request(app).post('/auth/refresh').set('Cookie', second)).status, 200);
});

test('reusing an old refresh token ends every session of that user', async () => {
  await register();
  const stolen = refreshCookie(await login());
  const res = await request(app).post('/auth/refresh').set('Cookie', stolen); // legitimate use
  const current = refreshCookie(res);
  // Pretend the legitimate use was a minute ago, past the 10-second race grace period.
  await query("UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL");

  const replay = await request(app).post('/auth/refresh').set('Cookie', stolen); // attacker
  assert.equal(replay.status, 401);
  assert.match(replay.body.error, /already used/);

  // The legitimate user's newer token was revoked too.
  assert.equal((await request(app).post('/auth/refresh').set('Cookie', current)).status, 401);
});

test('two refreshes with the same token at once: one succeeds, and its new token survives', async () => {
  await register();
  const cookie = refreshCookie(await login());
  const results = await Promise.all([
    request(app).post('/auth/refresh').set('Cookie', cookie),
    request(app).post('/auth/refresh').set('Cookie', cookie),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  // The race must not be mistaken for theft: the winner's new token still works.
  const winner = refreshCookie(results.find((r) => r.status === 200));
  assert.equal((await request(app).post('/auth/refresh').set('Cookie', winner)).status, 200);
});

test('refresh without a cookie is 401', async () => {
  const res = await request(app).post('/auth/refresh');
  assert.equal(res.status, 401);
});

test('logout revokes the refresh token and clears the cookie', async () => {
  await register();
  const cookie = refreshCookie(await login());

  const res = await request(app).post('/auth/logout').set('Cookie', cookie);
  assert.equal(res.status, 204);
  assert.match(res.headers['set-cookie'][0], /refresh_token=;/);

  assert.equal((await request(app).post('/auth/refresh').set('Cookie', cookie)).status, 401);
  assert.equal((await request(app).post('/auth/logout')).status, 204, 'logout twice is fine');
});

// ---- requireRole ----

test('requireRole: 401 without or with a bad token, 403 for the wrong role, next() otherwise', async () => {
  const guarded = express();
  guarded.get('/professor-only', requireRole('PROFESSOR'), (req, res) => res.json(req.user));
  guarded.use(errorHandler);

  await register();
  const { token } = (await login()).body;

  assert.equal((await request(guarded).get('/professor-only')).status, 401);
  assert.equal((await request(guarded).get('/professor-only').set('Authorization', 'Bearer nope')).status, 401);
  assert.equal((await request(guarded).get('/professor-only').set('Authorization', `Bearer ${token}`)).status, 403);

  await seedProfessors([{ name: 'Ada', email: 'ada@example.com', password: 'professor-pass' }], () => {});
  const prof = (await login('ada@example.com', 'professor-pass')).body;
  const res = await request(guarded).get('/professor-only').set('Authorization', `Bearer ${prof.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'PROFESSOR');
  assert.equal(res.body.id, prof.user.id);
});

// ---- seed script ----

test('seed creates, then updates a professor, and refuses a student email', async () => {
  const quiet = () => {};
  await seedProfessors([{ name: 'Ada', email: 'Ada@Example.com', password: 'first-password' }], quiet);
  await seedProfessors([{ name: 'Ada L.', email: 'ada@example.com', password: 'second-password' }], quiet);
  const { rows } = await query("SELECT name, email FROM users WHERE role = 'PROFESSOR'");
  assert.deepEqual(rows, [{ name: 'Ada L.', email: 'ada@example.com' }]);
  assert.equal((await login('ada@example.com', 'second-password')).status, 200);

  await register();
  const { refused } = await seedProfessors([{ name: 'X', email: ana.email, password: 'whatever-pass' }], quiet);
  assert.equal(refused, 1);
  const student = await query('SELECT role FROM users WHERE email = $1', ['ana@example.com']);
  assert.equal(student.rows[0].role, 'STUDENT');
});

test('seed input is validated', () => {
  assert.throws(() => parseProfessors(undefined), /not set/);
  assert.throws(() => parseProfessors('nope'), /JSON array/);
  assert.throws(() => parseProfessors('[{"name":"A","email":"a@x"}]'), /password is missing/);
});
