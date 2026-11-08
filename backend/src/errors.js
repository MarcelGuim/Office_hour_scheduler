// Every error response has the shape {"error": "message"} (docs/design.md, API conventions).

export class HttpError extends Error {
  // extra: optional fields merged into the body, e.g. {canJoinWaitlist: true}
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not found' });
}

// Express recognises an error handler by its four parameters, so `next` must stay.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  // Malformed JSON body or body too large, raised by express.json().
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body too large' });
  }
  // Anything else is a bug or an outage: log the details, return nothing internal.
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  return res.status(500).json({ error: 'internal server error' });
}
