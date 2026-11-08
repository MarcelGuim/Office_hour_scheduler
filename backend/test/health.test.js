import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupTestApp } from './helpers.js';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db.js';

let app;
before(async () => {
  app = await setupTestApp();
});
after(closePool);

test('GET /health returns ok when the database is reachable', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('GET /health returns 503 while shutting down', async () => {
  const stopping = createApp();
  stopping.locals.shuttingDown = true;
  const res = await request(stopping).get('/health');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: 'shutting down' });
});

test('unknown route returns 404 in the error format', async () => {
  const res = await request(app).get('/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not found' });
});

test('malformed JSON returns 400 in the error format', async () => {
  const res = await request(app)
    .post('/health')
    .set('Content-Type', 'application/json')
    .send('{bad json');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid JSON body' });
});

test('Swagger document lists /health and the auth endpoints', async () => {
  const res = await request(app).get('/docs.json');
  assert.equal(res.status, 200);
  for (const path of ['/health', '/auth/register', '/auth/login', '/auth/refresh', '/auth/logout']) {
    assert.ok(res.body.paths[path], `${path} missing from /docs.json`);
  }
});
