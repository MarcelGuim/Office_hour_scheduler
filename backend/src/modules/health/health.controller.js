// Controller: reads the request, calls the service, chooses the HTTP response.
// No SQL and no business rules here.

import { checkHealth } from './health.services.js';

export async function getHealth(req, res) {
  const result = await checkHealth({ shuttingDown: req.app.locals.shuttingDown });
  if (!result.ok) {
    return res.status(503).json({ error: result.reason });
  }
  return res.status(200).json({ status: 'ok' });
}
