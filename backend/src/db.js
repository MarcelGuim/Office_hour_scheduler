// PostgreSQL access: one connection pool per process, plus a transaction helper.

import pg from 'pg';

// Return DATE columns (session_date) as 'YYYY-MM-DD' strings. By default pg turns
// them into a JavaScript Date at local midnight, which shifts the day depending on
// the server's time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// Return bigint (for example count(*)) as a number. Our counts are far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

let pool;

export function initPool(databaseConfig) {
  pool = new pg.Pool({
    ...databaseConfig,
    max: 10, // connections per backend pod
    connectionTimeoutMillis: 3000, // fail fast (health check returns 503) instead of hanging
  });
  // An idle connection can drop, for example when the PostgreSQL pod restarts.
  // Without this listener that error would crash the process.
  pool.on('error', (err) => console.error('idle database connection error:', err.message));
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('Database pool not initialised; call initPool first');
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// Single statement outside a transaction.
export function query(text, params) {
  return getPool().query(text, params);
}

// Errors worth retrying: the transaction was rolled back by PostgreSQL itself,
// and running it again from the start is safe.
const RETRYABLE = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

// Runs fn(client) inside BEGIN ... COMMIT on one connection. Any thrown error rolls
// back. On a deadlock or serialization failure the whole function runs again, so fn
// must only change the database (emails go through the outbox table, not sent here).
export async function withTransaction(fn, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
