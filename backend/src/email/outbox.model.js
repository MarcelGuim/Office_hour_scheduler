// SQL for the email_outbox table (docs/schema.md section 6).
// enqueueEmail is called inside the transaction that decides the email, so the email
// exists if and only if that decision committed. The outbox loop sends it later.

import { getPool } from '../db.js';

export async function enqueueEmail({ to, subject, body }, db = getPool()) {
  await db.query('INSERT INTO email_outbox (to_email, subject, body) VALUES ($1, $2, $3)', [to, subject, body]);
}

// Takes up to `limit` emails that are due, locked so another pod skips them.
export async function claimDueEmails(limit, maxAttempts, db) {
  const { rows } = await db.query(
    `SELECT id, to_email AS "to", subject, body, attempts
       FROM email_outbox
      WHERE sent_at IS NULL AND next_attempt_at <= now() AND attempts < $2
      ORDER BY next_attempt_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, maxAttempts],
  );
  return rows;
}

export async function markSent(id, db) {
  await db.query('UPDATE email_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1', [id]);
}

// Retry later: 1, 2, 4, 8... minutes, capped at one hour.
export async function markFailed(id, error, db) {
  await db.query(
    `UPDATE email_outbox
        SET attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = now() + least(power(2, attempts), 60) * interval '1 minute'
      WHERE id = $1`,
    [id, String(error).slice(0, 1000)],
  );
}

// Local testing (DEV_MAILBOX): the latest emails, newest first.
export async function listRecentEmails(limit = 50, db = getPool()) {
  const { rows } = await db.query(
    `SELECT id, to_email AS "to", subject, body, created_at AS "createdAt", sent_at AS "sentAt"
       FROM email_outbox
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}
