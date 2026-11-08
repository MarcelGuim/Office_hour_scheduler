// Password hashing with bcrypt (pure-JavaScript bcryptjs: no native build in the image).
// Separate from the auth service so the seed script needs no JWT_SECRET.

import bcrypt from 'bcryptjs';
import { bcryptCost } from './config.js';

// Cost 10 = 2^10 rounds, about 50 ms on a laptop and more on a small cluster node.
// Raising it by 1 doubles the time of every login and registration.
export function hashPassword(password) {
  return bcrypt.hash(password, bcryptCost());
}

export function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}
