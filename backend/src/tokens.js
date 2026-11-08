// Random single-use tokens (refresh tokens now, offer links later).
// The token goes to the user; only its sha256 hash is stored (docs/schema.md section 5).

import { randomBytes, createHash } from 'node:crypto';

// 32 random bytes = 256 bits: impossible to guess, so a fast hash is enough to store it.
export function newToken() {
  return randomBytes(32).toString('base64url'); // URL- and cookie-safe characters
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
