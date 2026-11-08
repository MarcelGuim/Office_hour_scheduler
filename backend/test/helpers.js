// Test setup. Import this first in every test file.
// Tests use their own database, <DB_NAME>_test, on the Compose PostgreSQL, so they
// never touch development data. It is created and migrated on first use, and every
// table is emptied before each test file (files run one at a time: --test-concurrency=1).

import pg from 'pg';
import { databaseConfig } from '../src/config.js';
import { initPool, getPool } from '../src/db.js';
import { runMigrations } from '../scripts/migrate.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { seedProfessors } from '../scripts/seed-professors.js';

const baseDb = databaseConfig();
const testDbName = `${baseDb.database}_test`;
process.env.DB_NAME = testDbName; // everything after this point uses the test database
process.env.BCRYPT_COST ??= '4'; // the minimum: keeps tests fast, real cost is checked elsewhere

async function ensureTestDatabase() {
  const admin = new pg.Client(baseDb);
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDbName]);
    if (rowCount === 0) {
      // CREATE DATABASE cannot take a $1 parameter; the name comes from our own .env.
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(testDbName)}`);
    }
  } finally {
    await admin.end();
  }
}

// Returns a fresh app connected to an empty, migrated test database.
export async function setupTestApp() {
  await ensureTestDatabase();
  await runMigrations({ ...baseDb, database: testDbName }, () => {});
  initPool({ ...baseDb, database: testDbName });
  await resetDatabase();
  return createApp();
}

export async function resetDatabase() {
  const { rows } = await getPool().query(
    `SELECT string_agg(format('%I', tablename), ', ') AS tables
       FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  await getPool().query(`TRUNCATE ${rows[0].tables} RESTART IDENTITY CASCADE`);
}

// ---- users for tests ----

let counter = 0;

// Seeds a professor and logs in. Returns { token, user, auth } where auth is the header value.
export async function loginAsNewProfessor(app, name = 'Prof') {
  const email = `prof${++counter}@example.com`;
  await seedProfessors([{ name, email, password: 'professor-pass' }], () => {});
  return loginAs(app, email, 'professor-pass');
}

// Registers a student and logs in.
export async function loginAsNewStudent(app, name = 'Student') {
  const email = `student${++counter}@example.com`;
  const res = await request(app).post('/auth/register').send({ name, email, password: 'student-pass' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return loginAs(app, email, 'student-pass');
}

async function loginAs(app, email, password) {
  const res = await request(app).post('/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { token: res.body.token, user: res.body.user, auth: `Bearer ${res.body.token}` };
}

// ---- courses, slots and emails for tests ----

// An ISO time `daysAhead` days from now at hh:mm UTC. 15:00 to 20:00 UTC is the same
// Toronto day (10:00 to 16:00 local), so slots built this way share a session.
export function futureTime(daysAhead, hour, minute = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

export async function makeCourse(app, prof, code = `C${++counter}`) {
  const res = await request(app)
    .post('/professor/courses')
    .set('Authorization', prof.auth)
    .send({ code, name: `Course ${code}` });
  if (res.status !== 201) throw new Error(`course failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function makeSlot(app, prof, courseId, startsAt, minutes = 30) {
  const endsAt = new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString();
  const res = await request(app)
    .post('/professor/office-hours')
    .set('Authorization', prof.auth)
    .send({ courseId, startsAt, endsAt, location: 'BA 1234' });
  if (res.status !== 201) throw new Error(`slot failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function enrolledStudent(app, courseId, name) {
  const student = await loginAsNewStudent(app, name);
  const res = await request(app)
    .post('/student/enrollments')
    .set('Authorization', student.auth)
    .send({ courseId });
  if (res.status !== 201) throw new Error(`enroll failed: ${res.status}`);
  student.email = (await getPool().query('SELECT email FROM users WHERE id = $1', [student.user.id])).rows[0].email;
  return student;
}

export function book(app, student, officeHourId) {
  return request(app).post('/student/bookings').set('Authorization', student.auth).send({ officeHourId });
}

export function joinWaitlist(app, student, officeHourIds) {
  return request(app).post('/student/waitlist').set('Authorization', student.auth).send({ officeHourIds });
}

export function cancelBooking(app, student, officeHourId) {
  return request(app).delete(`/student/bookings/${officeHourId}`).set('Authorization', student.auth);
}

// The newest offer token emailed to this address (tokens exist only in the email).
export async function latestOfferToken(email) {
  const { rows } = await getPool().query(
    `SELECT body FROM email_outbox
      WHERE to_email = $1 AND subject LIKE 'Office hour available:%'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [email],
  );
  if (!rows[0]) return null;
  return rows[0].body.match(/offer\.html#([A-Za-z0-9_-]+)/)[1];
}

export function respond(app, token, interested) {
  return request(app).post(`/offers/${token}/respond`).send({ interested });
}

// Makes the slot's open round look past its deadline, as if minutes had gone by.
export async function expireRound(officeHourId) {
  await getPool().query(
    "UPDATE offer_rounds SET expires_at = now() - interval '1 second' WHERE office_hour_id = $1 AND status = 'OPEN'",
    [officeHourId],
  );
}
