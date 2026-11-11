// Local testing only (DEV_MAILBOX=true): lists the latest queued emails, offer links
// included, so the app can be tried without a real mail account. No authentication,
// which is why it must never be enabled in the cluster. Not in Swagger on purpose.

import { Router } from 'express';
import { listRecentEmails } from './outbox.model.js';

const router = Router();

router.get('/dev/mailbox', async (req, res) => {
  res.status(200).json(await listRecentEmails(50));
});

export default router;
