// SQL for the auth module: the users and refresh_tokens tables.
// Every function takes an optional `db` (a transaction client from withTransaction);
// without it, the query runs on the pool.

import { getPool } from '../../db.js';

// Database row → API object. Never includes password_hash.
function toUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

// ---- users ----

// Emails are stored lowercased. The unique index on lower(email) also rejects
// case-only duplicates if anything ever inserts without lowercasing.
export async function insertStudent({ name, email, passwordHash }, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, lower($2), $3, 'STUDENT')
     RETURNING id, name, email, role`,
    [name, email, passwordHash],
  );
  return toUser(rows[0]);
}

// For login only: the one place password_hash leaves the database.
export async function findUserWithPasswordByEmail(email, db = getPool()) {
  const { rows } = await db.query(
    `SELECT id, name, email, role, password_hash
       FROM users
      WHERE lower(email) = lower($1)`, // matches the users_email_lower index
    [email],
  );
  if (!rows[0]) return null;
  return { ...toUser(rows[0]), passwordHash: rows[0].password_hash };
}

export async function findUserById(id, db = getPool()) {
  const { rows } = await db.query('SELECT id, name, email, role FROM users WHERE id = $1', [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

// Seed script: create a professor, or update the name and password of an existing one.
// Returns null if the email belongs to a student (the WHERE stops the update), so a
// seed file can never turn a student into a professor.
export async function upsertProfessor({ name, email, passwordHash }, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, lower($2), $3, 'PROFESSOR')
     ON CONFLICT ((lower(email))) DO UPDATE
       SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash
       WHERE users.role = 'PROFESSOR'
     RETURNING id, name, email, role, (xmax = 0) AS inserted`,
    [name, email, passwordHash],
  );
  // xmax = 0 is PostgreSQL's way to tell a fresh insert from an update.
  return rows[0] ? { ...toUser(rows[0]), inserted: rows[0].inserted } : null;
}

// ---- refresh tokens ----

export async function insertRefreshToken({ userId, tokenHash, ttlDays }, db = getPool()) {
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, tokenHash, ttlDays],
  );
}

// Uses up a refresh token in one statement: revokes it only if it is still valid,
// and returns its user. If two requests present the same token at once, only one
// gets the row back; the other sees zero rows.
export async function consumeRefreshToken(tokenHash, db = getPool()) {
  const { rows } = await db.query(
    `UPDATE refresh_tokens
        SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [tokenHash],
  );
  return rows[0] ? rows[0].user_id : null;
}

// revokedSecondsAgo is computed by PostgreSQL, so pod clocks don't matter.
export async function findRefreshToken(tokenHash, db = getPool()) {
  const { rows } = await db.query(
    `SELECT user_id, revoked_at,
            extract(epoch FROM now() - revoked_at) AS revoked_seconds_ago
       FROM refresh_tokens
      WHERE token_hash = $1`,
    [tokenHash],
  );
  if (!rows[0]) return null;
  return {
    userId: rows[0].user_id,
    revokedAt: rows[0].revoked_at,
    revokedSecondsAgo: rows[0].revoked_seconds_ago === null ? null : Number(rows[0].revoked_seconds_ago),
  };
}

export async function revokeRefreshToken(tokenHash, db = getPool()) {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
}

export async function revokeAllRefreshTokens(userId, db = getPool()) {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}
