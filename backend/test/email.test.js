import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, resetDatabase } from './helpers.js';
import { closePool, query } from '../src/db.js';
import { enqueueEmail } from '../src/email/outbox.model.js';
import { sendDueEmails } from '../src/email/outbox.services.js';

before(setupTestApp);
beforeEach(resetDatabase);
after(closePool);

test('the outbox loop sends due emails once and marks them sent', async (t) => {
  t.mock.method(console, 'log', () => {}); // no SMTP in tests: the mailer prints instead
  await enqueueEmail({ to: 'a@example.com', subject: 'One', body: 'x' });
  await enqueueEmail({ to: 'b@example.com', subject: 'Two', body: 'y' });

  const [first, second] = await Promise.all([sendDueEmails(), sendDueEmails()]);
  assert.equal(first + second, 2, 'two loops (two pods) never send the same email twice');
  assert.equal(await sendDueEmails(), 0, 'nothing left');
  const { rows } = await query('SELECT count(*) AS n FROM email_outbox WHERE sent_at IS NOT NULL AND attempts = 1');
  assert.equal(rows[0].n, 2);
});
