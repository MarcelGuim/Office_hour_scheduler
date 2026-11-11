// The outbox loop's work: send due emails. Runs in every backend pod; FOR UPDATE SKIP
// LOCKED gives each email to one pod at a time. Delivery is at least once: if a pod dies
// after sending but before committing, the email is sent again later.

import { withTransaction } from '../db.js';
import { sendEmail } from './mailer.js';
import * as outbox from './outbox.model.js';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 8;

// Returns how many emails were sent.
export async function sendDueEmails() {
  return withTransaction(async (client) => {
    const emails = await outbox.claimDueEmails(BATCH_SIZE, MAX_ATTEMPTS, client);
    let sent = 0;
    for (const email of emails) {
      try {
        await sendEmail(email);
        await outbox.markSent(email.id, client);
        sent++;
      } catch (err) {
        console.error(`email ${email.id} to ${email.to} failed (attempt ${email.attempts + 1}):`, err.message);
        await outbox.markFailed(email.id, err.message, client);
      }
    }
    return sent;
  });
}
