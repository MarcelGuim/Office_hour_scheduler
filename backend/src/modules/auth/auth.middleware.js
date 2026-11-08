// Route guards used by the other modules' routes files, for example:
//   router.post('/professor/courses', requireRole('PROFESSOR'), rules, controller)
// They run before validation and the controller.

import { HttpError } from '../../errors.js';
import { verifyAccessToken } from './auth.services.js';

// 401 unless the request has a valid "Authorization: Bearer <JWT>" header.
// On success, req.user = { id, role, name }.
export function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'missing bearer token'));
  }
  req.user = verifyAccessToken(token); // throws 401 if invalid or expired
  return next();
}

// requireAuth, then 403 unless the user has the given role.
export function requireRole(role) {
  return [
    requireAuth,
    (req, res, next) => {
      if (req.user.role !== role) return next(new HttpError(403, 'forbidden'));
      return next();
    },
  ];
}
