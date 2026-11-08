// Shared piece of every module's X.validation.js. A module lists its express-validator
// rules, then ends the chain with `validate`, which turns the first failed rule into
// 400 {"error": "..."} (the API's error format) before the controller runs.
//
// Sanitizers (trim, toUpperCase...) update req.body, but NOT req.query or req.params:
// Express 5 makes those read-only. Controllers read query and path values with
// matchedData(req) from express-validator to get the sanitized copy.

import { validationResult } from 'express-validator';
import { HttpError } from './errors.js';

export function validate(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const first = errors.array()[0];
  return next(new HttpError(400, first.msg));
}
