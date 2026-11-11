import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  setupTestApp, resetDatabase, loginAsNewProfessor, loginAsNewStudent, futureTime, makeCourse,
  makeSlot, enrolledStudent, book, cancelBooking, joinWaitlist, latestOfferToken,
} from './helpers.js';
import { closePool, query } from '../src/db.js';

let app;
before(async () => {
  app = await setupTestApp();
});
beforeEach(resetDatabase);
after(closePool);

// Two taken slots on day 3, one taken slot on day 4, all in one course.
async function setup() {
  const prof = await loginAsNewProfessor(app);
  const course = await makeCourse(app, prof);
  const a = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const b = await makeSlot(app, prof, course.id, futureTime(3, 16));
  const nextDay = await makeSlot(app, prof, course.id, futureTime(4, 15));
  const holder = await enrolledStudent(app, course.id, 'Holder');
  await book(app, holder, a.id);
  await book(app, holder, nextDay.id);
  const holder2 = await enrolledStudent(app, course.id, 'Holder2');
  await book(app, holder2, b.id);
  return { prof, course, a, b, nextDay, holder };
}

test('join with several taken slots of one day; list shows them and no pending offer', async () => {
  const { course, a, b } = await setup();
  const ana = await enrolledStudent(app, course.id);
  const res = await joinWaitlist(app, ana, [a.id, b.id]);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.officeHourIds, [a.id, b.id]);
  assert.match(res.body.sessionDate, /^\d{4}-\d{2}-\d{2}$/);

  const list = await request(app).get('/student/waitlist').set('Authorization', ana.auth);
  assert.equal(list.body.length, 1);
  assert.deepEqual(list.body[0].officeHourIds.sort(), [a.id, b.id].sort());
  assert.equal(list.body[0].offerPending, false);

  const view = await request(app).get('/student/office-hours').set('Authorization', ana.auth);
  assert.deepEqual(view.body.filter((s) => s.myStatus === 'WAITLISTED').length, 2);
});

test('join rules', async () => {
  const { prof, course, a, nextDay } = await setup();
  const free = await makeSlot(app, prof, course.id, futureTime(3, 18));
  const otherCourse = await makeCourse(app, prof);
  const elsewhere = await makeSlot(app, prof, otherCourse.id, futureTime(3, 15));
  const ana = await enrolledStudent(app, course.id);

  const cases = [
    [[], 400, 'officeHourIds must list 1 to 20 office hours'],
    [[a.id, a.id], 400, 'officeHourIds must not repeat an office hour'],
    [['nope'], 400, 'officeHourIds must be UUIDs'],
    [['00000000-0000-4000-8000-000000000000'], 404, 'office hour not found'],
    [[a.id, nextDay.id], 400, 'all office hours must be of the same course and day'],
    [[a.id, elsewhere.id], 400, 'all office hours must be of the same course and day'],
    [[free.id], 409, 'an office hour is free: book it instead'],
  ];
  for (const [ids, status, error] of cases) {
    const res = await joinWaitlist(app, ana, ids);
    assert.equal(res.status, status, error);
    assert.deepEqual(res.body, { error });
  }

  const outsider = await loginAsNewStudent(app);
  assert.equal((await joinWaitlist(app, outsider, [a.id])).status, 403);

  assert.equal((await joinWaitlist(app, ana, [a.id])).status, 201);
  assert.deepEqual((await joinWaitlist(app, ana, [a.id])).body, {
    error: 'you are already on the waitlist for this course on this day',
  });
});

test('a student with a booking that day cannot join that day, but can join another day', async () => {
  const { prof, course, a, nextDay } = await setup();
  const mine = await makeSlot(app, prof, course.id, futureTime(3, 18));
  const ana = await enrolledStudent(app, course.id);
  await book(app, ana, mine.id);
  assert.deepEqual((await joinWaitlist(app, ana, [a.id])).body, {
    error: 'you already have an office hour for this course on this day',
  });
  assert.equal((await joinWaitlist(app, ana, [nextDay.id])).status, 201);
});

test('the holder of a slot cannot join its waitlist', async () => {
  const { a, holder } = await setup();
  assert.deepEqual((await joinWaitlist(app, holder, [a.id])).body, {
    error: 'you already booked one of these office hours',
  });
});

test('a slot in an open offer round can be joined (it is not bookable)', async () => {
  const { course, a, holder } = await setup();
  const ana = await enrolledStudent(app, course.id);
  const bob = await enrolledStudent(app, course.id);
  await joinWaitlist(app, ana, [a.id]);
  await cancelBooking(app, holder, a.id); // round opens for Ana
  assert.equal((await joinWaitlist(app, bob, [a.id])).status, 201);
});

test('leaving withdraws the entry; a pending offer is cancelled and passes on', async () => {
  const { course, a, holder } = await setup();
  const ana = await enrolledStudent(app, course.id);
  const bob = await enrolledStudent(app, course.id);
  const anaEntry = (await joinWaitlist(app, ana, [a.id])).body;
  await joinWaitlist(app, bob, [a.id]);
  await cancelBooking(app, holder, a.id); // Ana rank 1, Bob rank 2

  const pending = await request(app).get('/student/waitlist').set('Authorization', ana.auth);
  assert.equal(pending.body[0].offerPending, true);

  const res = await request(app).delete(`/student/waitlist/${anaEntry.id}`).set('Authorization', ana.auth);
  assert.equal(res.status, 204);
  assert.equal((await request(app).get(`/offers/${await latestOfferToken(ana.email)}`)).body.status, 'CANCELLED');
  const flagged = await query("SELECT needs_resolve FROM offer_rounds WHERE status = 'OPEN'");
  assert.equal(flagged.rows[0].needs_resolve, true, 'the worker will move the round on');

  assert.equal((await request(app).delete(`/student/waitlist/${anaEntry.id}`).set('Authorization', bob.auth)).status, 404);
});
