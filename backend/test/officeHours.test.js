import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  setupTestApp, resetDatabase, loginAsNewProfessor, loginAsNewStudent,
  futureTime, makeCourse, makeSlot, enrolledStudent, book, cancelBooking, joinWaitlist,
} from './helpers.js';
import { closePool, query } from '../src/db.js';

let app;
before(async () => {
  app = await setupTestApp();
});
beforeEach(resetDatabase);
after(closePool);

async function setup() {
  const prof = await loginAsNewProfessor(app);
  const course = await makeCourse(app, prof);
  return { prof, course };
}

// ---- professor: create, list, view ----

test('professor creates an office hour; location and times come back', async () => {
  const { prof, course } = await setup();
  const startsAt = futureTime(3, 15);
  const slot = await makeSlot(app, prof, course.id, startsAt);
  assert.equal(slot.courseId, course.id);
  assert.equal(new Date(slot.startsAt).toISOString(), startsAt);
  assert.equal(slot.location, 'BA 1234');
});

test('create validates times and ownership', async () => {
  const { prof, course } = await setup();
  const other = await loginAsNewProfessor(app);
  const post = (who, body) =>
    request(app).post('/professor/office-hours').set('Authorization', who.auth).send(body);
  const ok = { courseId: course.id, startsAt: futureTime(3, 15), endsAt: futureTime(3, 16), location: 'BA 1234' };

  const cases = [
    [{ ...ok, endsAt: futureTime(3, 14) }, 400, 'endsAt must be after startsAt'],
    [{ ...ok, startsAt: '2020-01-01T10:00:00Z', endsAt: '2020-01-01T11:00:00Z' }, 400, 'startsAt must be in the future'],
    [{ ...ok, startsAt: '2026-11-12T10:00' }, 400, 'startsAt must include a time zone (Z or +hh:mm)'],
    [{ ...ok, location: '' }, 400, 'location must be 1 to 200 characters'],
    [{ ...ok, courseId: '00000000-0000-4000-8000-000000000000' }, 404, 'course not found'],
  ];
  for (const [body, status, error] of cases) {
    const res = await post(prof, body);
    assert.equal(res.status, status, error);
    assert.deepEqual(res.body, { error });
  }
  assert.equal((await post(other, ok)).status, 403);
});

test('professor list shows booked student, waitlist count and round state; detail shows the queue', async () => {
  const { prof, course } = await setup();
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const ana = await enrolledStudent(app, course.id, 'Ana');
  const bob = await enrolledStudent(app, course.id, 'Bob');
  assert.equal((await book(app, ana, slot.id)).status, 201);
  assert.equal((await joinWaitlist(app, bob, [slot.id])).status, 201);

  const list = await request(app).get('/professor/office-hours').set('Authorization', prof.auth);
  assert.equal(list.status, 200);
  assert.equal(list.body[0].bookedBy.name, 'Ana');
  assert.equal(list.body[0].waitlisted, 1);
  assert.equal(list.body[0].offerRoundOpen, false);

  const detail = await request(app).get(`/professor/office-hours/${slot.id}`).set('Authorization', prof.auth);
  assert.deepEqual(detail.body.waitlist.map((w) => w.name), ['Bob']);

  const other = await loginAsNewProfessor(app);
  assert.equal((await request(app).get(`/professor/office-hours/${slot.id}`).set('Authorization', other.auth)).status, 403);
});

// ---- student view ----

test('student sees only upcoming slots of enrolled courses, with available and myStatus', async () => {
  const { prof, course } = await setup();
  const otherCourse = await makeCourse(app, prof);
  const a = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const b = await makeSlot(app, prof, course.id, futureTime(3, 16));
  await makeSlot(app, prof, otherCourse.id, futureTime(3, 15)); // not enrolled: hidden
  const ana = await enrolledStudent(app, course.id, 'Ana');
  const bob = await enrolledStudent(app, course.id, 'Bob');
  await book(app, bob, a.id);
  await book(app, ana, b.id);

  const res = await request(app).get('/student/office-hours').set('Authorization', ana.auth);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((s) => [s.id, s.available, s.myStatus]),
    [[a.id, false, 'NONE'], [b.id, false, 'BOOKED']],
  );
  assert.equal(JSON.stringify(res.body).includes('Bob'), false, 'no other students\' names');
});

// ---- booking: hard problem 1 ----

test('50 students click the same free slot at once: exactly one booking', async () => {
  const { prof, course } = await setup();
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const students = [];
  for (let i = 0; i < 50; i++) students.push(await enrolledStudent(app, course.id));

  const results = await Promise.all(students.map((s) => book(app, s, slot.id)));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 49);
  for (const r of results.filter((x) => x.status === 409)) {
    assert.deepEqual(r.body, { error: 'taken', canJoinWaitlist: true });
  }
  const { rows } = await query('SELECT booked_by FROM office_hours WHERE id = $1', [slot.id]);
  const winner = results.findIndex((r) => r.status === 201);
  assert.equal(rows[0].booked_by, students[winner].user.id);
});

test('one booking per course per Toronto day, even for two slots booked at the same instant', async () => {
  const { prof, course } = await setup();
  const a = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const b = await makeSlot(app, prof, course.id, futureTime(3, 16));
  const nextDay = await makeSlot(app, prof, course.id, futureTime(4, 15));
  const ana = await enrolledStudent(app, course.id);

  const both = await Promise.all([book(app, ana, a.id), book(app, ana, b.id)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  const refused = both.find((r) => r.status === 409);
  assert.deepEqual(refused.body, { error: 'you already have an office hour for this course on this day' });

  assert.equal((await book(app, ana, nextDay.id)).status, 201, 'another day is fine');
});

test('a late-evening UTC time counts as the previous Toronto day', async () => {
  const { prof, course } = await setup();
  const evening = await makeSlot(app, prof, course.id, futureTime(3, 15)); // 10:00 Toronto
  const night = await makeSlot(app, prof, course.id, futureTime(4, 2)); // 21:00 Toronto, same day
  const ana = await enrolledStudent(app, course.id);
  assert.equal((await book(app, ana, evening.id)).status, 201);
  assert.equal((await book(app, ana, night.id)).status, 409);
});

test('booking errors: not enrolled 403, unknown 404, own 409, cancelled or started 400', async () => {
  const { prof, course } = await setup();
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const outsider = await loginAsNewStudent(app);
  assert.equal((await book(app, outsider, slot.id)).status, 403);

  const ana = await enrolledStudent(app, course.id);
  assert.equal((await book(app, ana, '00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await book(app, ana, slot.id)).status, 201);
  assert.deepEqual((await book(app, ana, slot.id)).body, { error: 'you already booked this office hour' });

  const cancelled = await makeSlot(app, prof, course.id, futureTime(5, 15));
  await request(app).delete(`/professor/office-hours/${cancelled.id}`).set('Authorization', prof.auth);
  assert.deepEqual((await book(app, ana, cancelled.id)).body, { error: 'office hour was cancelled' });

  const started = await makeSlot(app, prof, course.id, futureTime(6, 15));
  await query("UPDATE office_hours SET starts_at = now() - interval '1 minute', ends_at = now() + interval '1 hour' WHERE id = $1", [started.id]);
  assert.deepEqual((await book(app, ana, started.id)).body, { error: 'office hour has already started' });
});

test('booking directly removes my waitlist entry for that day, not for other days', async () => {
  const { prof, course } = await setup();
  const taken = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const free = await makeSlot(app, prof, course.id, futureTime(3, 16));
  const takenOtherDay = await makeSlot(app, prof, course.id, futureTime(4, 15));
  const bob = await enrolledStudent(app, course.id);
  const ana = await enrolledStudent(app, course.id);
  await book(app, bob, taken.id);
  await book(app, bob, takenOtherDay.id);
  assert.equal((await joinWaitlist(app, ana, [taken.id])).status, 201);
  assert.equal((await joinWaitlist(app, ana, [takenOtherDay.id])).status, 201);

  assert.equal((await book(app, ana, free.id)).status, 201);
  const entries = await request(app).get('/student/waitlist').set('Authorization', ana.auth);
  assert.deepEqual(entries.body.map((e) => e.officeHourIds), [[takenOtherDay.id]]);
});

// ---- cancelling ----

test('cancel my booking: the slot is free again when nobody waits', async () => {
  const { prof, course } = await setup();
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const ana = await enrolledStudent(app, course.id);
  const bob = await enrolledStudent(app, course.id);
  await book(app, ana, slot.id);
  assert.equal((await cancelBooking(app, bob, slot.id)).status, 404, 'not my booking');
  assert.equal((await cancelBooking(app, ana, slot.id)).status, 204);
  assert.equal((await book(app, bob, slot.id)).status, 201);
});

test('cancel with someone waiting: an offer round opens and direct booking is refused', async () => {
  const { prof, course } = await setup();
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const ana = await enrolledStudent(app, course.id);
  const bob = await enrolledStudent(app, course.id);
  const carl = await enrolledStudent(app, course.id);
  await book(app, ana, slot.id);
  await joinWaitlist(app, bob, [slot.id]);

  assert.equal((await cancelBooking(app, ana, slot.id)).status, 204);
  const res = await book(app, carl, slot.id);
  assert.equal(res.status, 409, 'reserved for the waitlist while the round is open');
  assert.deepEqual(res.body, { error: 'taken', canJoinWaitlist: true });

  const view = await request(app).get('/student/office-hours').set('Authorization', carl.auth);
  assert.equal(view.body[0].available, false);
});

test('a booking cannot be cancelled after the slot started', async () => {
  const { prof, course } = await setup();
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const ana = await enrolledStudent(app, course.id);
  await book(app, ana, slot.id);
  await query("UPDATE office_hours SET starts_at = now() - interval '1 minute', ends_at = now() + interval '1 hour' WHERE id = $1", [slot.id]);
  assert.equal((await cancelBooking(app, ana, slot.id)).status, 400);
});

test('professor cancels: booked student is emailed, slot leaves waitlists, no offers', async () => {
  const { prof, course } = await setup();
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const other = await makeSlot(app, prof, course.id, futureTime(3, 16));
  const ana = await enrolledStudent(app, course.id, 'Ana');
  const bob = await enrolledStudent(app, course.id, 'Bob');
  const carl = await enrolledStudent(app, course.id, 'Carl');
  await book(app, ana, slot.id);
  await book(app, carl, other.id);
  await joinWaitlist(app, bob, [slot.id, other.id]);

  const res = await request(app).delete(`/professor/office-hours/${slot.id}`).set('Authorization', prof.auth);
  assert.equal(res.status, 204);

  const mail = await query("SELECT to_email, subject FROM email_outbox WHERE subject LIKE 'Office hour cancelled%'");
  assert.deepEqual(mail.rows.map((m) => m.to_email), [ana.email]);
  const offers = await query('SELECT count(*) AS n FROM offers');
  assert.equal(offers.rows[0].n, 0, 'professor cancellation sends no offers');

  const entries = await request(app).get('/student/waitlist').set('Authorization', bob.auth);
  assert.deepEqual(entries.body[0].officeHourIds, [other.id], 'cancelled slot removed from the entry');

  const again = await request(app).delete(`/professor/office-hours/${slot.id}`).set('Authorization', prof.auth);
  assert.equal(again.status, 204, 'cancelling twice is fine');
});
