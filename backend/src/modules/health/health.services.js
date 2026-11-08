// Service: the rules. Decides whether this pod is ready, using the model for the
// database part. Knows nothing about HTTP (no req, no res, no status codes).

import { pingDatabase } from './health.model.js';

export async function checkHealth({ shuttingDown }) {
  if (shuttingDown) {
    return { ok: false, reason: 'shutting down' };
  }
  try {
    await pingDatabase();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'database unreachable' };
  }
}
