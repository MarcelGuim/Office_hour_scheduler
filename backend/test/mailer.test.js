// The Gmail API sender, with fetch replaced: no request ever reaches Google.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmailSender } from '../src/email/mailer.js';

const gmail = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken', from: 'Office Hours <sender@example.com>' };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Records each call and answers from `responses` in order.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fn, calls };
}

test('sends one message: refreshes the access token, then posts the MIME message', async () => {
  const { fn, calls } = fakeFetch([json(200, { access_token: 'at1', expires_in: 3599 }), json(200, { id: 'm1' })]);
  const send = createGmailSender(gmail, fn);

  await send({ to: 'student@example.com', subject: 'A slot is free', body: 'Answer here: http://x/offer.html#t' });

  assert.equal(calls.length, 2);
  const [token, sent] = calls;
  assert.equal(token.url, 'https://oauth2.googleapis.com/token');
  const form = new URLSearchParams(token.options.body.toString());
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'rtoken');
  assert.equal(form.get('client_id'), 'cid');

  assert.equal(sent.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(sent.options.headers.Authorization, 'Bearer at1');
  const mime = Buffer.from(JSON.parse(sent.options.body).raw, 'base64url').toString();
  assert.match(mime, /^To: student@example\.com$/m);
  assert.match(mime, /^From: Office Hours <sender@example\.com>$/m);
  assert.match(mime, /^Subject: A slot is free$/m);
  assert.match(mime, /Answer here: http:\/\/x\/offer\.html#t/);
});

test('reuses the access token until it expires', async () => {
  const { fn, calls } = fakeFetch([
    json(200, { access_token: 'at1', expires_in: 3599 }),
    json(200, { id: 'm1' }),
    json(200, { id: 'm2' }),
  ]);
  const send = createGmailSender(gmail, fn);
  await send({ to: 'a@example.com', subject: 's', body: 'b' });
  await send({ to: 'b@example.com', subject: 's', body: 'b' });
  assert.deepEqual(
    calls.map((c) => new URL(c.url).hostname),
    ['oauth2.googleapis.com', 'gmail.googleapis.com', 'gmail.googleapis.com'],
  );
});

test('a rejected refresh token throws without leaking credentials', async () => {
  const { fn } = fakeFetch([json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })]);
  const send = createGmailSender(gmail, fn);
  await assert.rejects(send({ to: 'a@example.com', subject: 's', body: 'b' }), (err) => {
    assert.match(err.message, /token refresh failed: HTTP 400 Token has been expired or revoked/);
    assert.doesNotMatch(err.message, /rtoken|csecret/);
    return true;
  });
});

test('a 401 from the send call throws and forces a new access token next time', async () => {
  const { fn, calls } = fakeFetch([
    json(200, { access_token: 'at1', expires_in: 3599 }),
    json(401, { error: { message: 'Invalid Credentials' } }),
    json(200, { access_token: 'at2', expires_in: 3599 }),
    json(200, { id: 'm1' }),
  ]);
  const send = createGmailSender(gmail, fn);
  await assert.rejects(send({ to: 'a@example.com', subject: 's', body: 'b' }), /send failed: HTTP 401 Invalid Credentials/);
  await send({ to: 'a@example.com', subject: 's', body: 'b' });
  assert.equal(calls[3].options.headers.Authorization, 'Bearer at2');
});
