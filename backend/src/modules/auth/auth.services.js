// Auth rules: access tokens (JWT), refresh-token rotation, login and registration.
// No req/res here; failures are thrown as HttpError and turned into responses by errors.js.

import jwt from 'jsonwebtoken';
import { getConfig } from '../../config.js';
import { withTransaction } from '../../db.js';
import { HttpError } from '../../errors.js';
import { newToken, hashToken } from '../../tokens.js';
import { hashPassword, checkPassword } from '../../passwords.js';
import * as model from './auth.model.js';

const UNIQUE_VIOLATION = '23505';

export async function register({ name, email, password }) {
  const passwordHash = await hashPassword(password);
  try {
    return await model.insertStudent({ name, email, passwordHash });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'email already registered');
    throw err;
  }
}

// Hash compared against when the email doesn't exist, so a wrong email takes as long
// as a wrong password. Otherwise response time would reveal which emails are registered.
let dummyHash;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password');
  return dummyHash;
}

export async function login({ email, password }) {
  const user = await model.findUserWithPasswordByEmail(email);
  const ok = await checkPassword(password, user ? user.passwordHash : await getDummyHash());
  if (!user || !ok) {
    // Same message for both cases, for the same reason as the dummy hash.
    throw new HttpError(401, 'invalid email or password');
  }
  return issueSession(user);
}

// A token used up this recently is treated as two requests racing (for example two
// tabs refreshing at once), not as theft: the loser just gets 401 and logs in again.
const REUSE_GRACE_SECONDS = 10;

// Exchanges a valid refresh token for a new access token and a new refresh token.
// The old refresh token stops working (rotation). If an already-used token comes back
// later than the grace period, someone kept a copy of it: every session of that user
// is ended.
export async function refresh(refreshToken) {
  if (!refreshToken) throw new HttpError(401, 'missing refresh token');
  const tokenHash = hashToken(refreshToken);

  const result = await withTransaction(async (client) => {
    const userId = await model.consumeRefreshToken(tokenHash, client);
    if (userId) {
      const user = await model.findUserById(userId, client);
      return { session: await issueSession(user, client) };
    }
    const existing = await model.findRefreshToken(tokenHash, client);
    if (existing && existing.revokedAt && existing.revokedSecondsAgo > REUSE_GRACE_SECONDS) {
      await model.revokeAllRefreshTokens(existing.userId, client);
      return { reused: true };
    }
    return { invalid: true }; // unknown or expired
  });

  // Thrown after the transaction, so the revocation above is committed, not rolled back.
  if (result.reused) throw new HttpError(401, 'refresh token already used; please log in again');
  if (result.invalid) throw new HttpError(401, 'invalid or expired refresh token');
  return result.session;
}

export async function logout(refreshToken) {
  if (refreshToken) await model.revokeRefreshToken(hashToken(refreshToken));
}

// Checks an access token and returns the user it was issued to.
export function verifyAccessToken(token) {
  try {
    const claims = jwt.verify(token, getConfig().jwtSecret, { algorithms: ['HS256'] });
    return { id: claims.sub, role: claims.role, name: claims.name };
  } catch {
    throw new HttpError(401, 'invalid or expired token');
  }
}

async function issueSession(user, db) {
  const config = getConfig();
  const token = jwt.sign({ role: user.role, name: user.name }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: config.accessTokenTtlSeconds,
  });
  const refreshToken = newToken();
  await model.insertRefreshToken(
    { userId: user.id, tokenHash: hashToken(refreshToken), ttlDays: config.refreshTokenTtlDays },
    db,
  );
  return {
    token,
    expiresIn: config.accessTokenTtlSeconds,
    user: { id: user.id, name: user.name, role: user.role },
    refreshToken, // goes into the cookie, never into the response body
  };
}
