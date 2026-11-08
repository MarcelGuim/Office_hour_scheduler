// Applies backend/migrations/*.sql in filename order, each file once.
// Applied files are recorded in schema_migrations. Each file runs in its own
// transaction, so a failing file leaves no partial changes and is retried next run.
// An advisory lock makes concurrent runs (two Jobs, or Compose restarts) wait
// for each other instead of applying the same file twice.
//
// Usage: node scripts/migrate.js  (reads DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
// the same variables as the app; see src/config.js)
// Tests import runMigrations() to prepare their own database.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseConfig } from '../src/config.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_ID = 1779; // arbitrary constant shared by every runner

export async function runMigrations(dbConfig, log = console.log) {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    log('migrations up to date');
  } finally {
    await client.end(); // closing the session also releases the advisory lock
  }
}

// Run only when started as a script, not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations(databaseConfig()).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
