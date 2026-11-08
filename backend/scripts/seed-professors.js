// Creates professor accounts (professors cannot register through the API).
// Reads SEED_PROFESSORS, a JSON array, from the environment so that no password is
// ever committed. Locally it lives in .env; in the cluster, in a Kubernetes Secret.
//
//   SEED_PROFESSORS='[{"name":"Ada Lovelace","email":"ada@example.com","password":"..."}]'
//
// Safe to run again: an existing professor gets the new name and password; an email
// that belongs to a student is refused (it never becomes a professor).
//
// Usage: npm run seed:professors   (or: node scripts/seed-professors.js)

import { pathToFileURL } from 'node:url';
import { databaseConfig } from '../src/config.js';
import { initPool, closePool } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { upsertProfessor } from '../src/modules/auth/auth.model.js';

export function parseProfessors(raw) {
  if (!raw) throw new Error('SEED_PROFESSORS is not set');
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('SEED_PROFESSORS must be a JSON array');
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('SEED_PROFESSORS must be a non-empty JSON array');
  }
  for (const [i, p] of list.entries()) {
    for (const field of ['name', 'email', 'password']) {
      if (typeof p?.[field] !== 'string' || p[field].trim() === '') {
        throw new Error(`SEED_PROFESSORS[${i}].${field} is missing`);
      }
    }
    const bytes = Buffer.byteLength(p.password, 'utf8');
    if (p.password.length < 8 || bytes > 72) {
      throw new Error(`SEED_PROFESSORS[${i}].password must be 8 characters to 72 bytes`);
    }
  }
  return list.map((p) => ({ name: p.name.trim(), email: p.email.trim(), password: p.password }));
}

export async function seedProfessors(list, log = console.log) {
  let refused = 0;
  for (const p of list) {
    const result = await upsertProfessor({
      name: p.name,
      email: p.email,
      passwordHash: await hashPassword(p.password),
    });
    if (!result) {
      refused++;
      log(`refused ${p.email}: already registered as a student`);
    } else {
      log(`${result.inserted ? 'created' : 'updated'} professor ${result.email}`);
    }
  }
  return { refused };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const list = parseProfessors(process.env.SEED_PROFESSORS);
    initPool(databaseConfig());
    const { refused } = await seedProfessors(list);
    process.exitCode = refused > 0 ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
