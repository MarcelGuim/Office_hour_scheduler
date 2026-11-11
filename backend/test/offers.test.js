// Offer rounds: hard problems 2 and 3 (docs/design.md section 4, section 10).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  setupTestApp, resetDatabase, loginAsNewProfessor, futureTime, makeCourse, makeSlot,
  enrolledStudent, book, cancelBooking, joinWaitlist, latestOfferToken, respond, expireRound,
} from './helpers.js';
import { closePool, initPool, query } from '../src/db.js';
import { databaseConfig } from '../src/config.js';
import { resolveDueRounds } from '../src/modules/offers/offers.services.js';

let app;
before(async () => {
  app = await setupTestApp();
});
beforeEach(resetDatabase);
after(closePool);

// A booked slot with `n` students waiting (in this order), ready to be freed.
async function scenario(n = 4) {
  const prof = await loginAsNewProfessor(app);
  const course = await makeCourse(app, prof);
  const slot = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const holder = await enrolledStudent(app, course.id, 'Holder');
  await book(app, holder, slot.id);
  const waiting = [];
  for (let i = 1; i <= n; i++) {
    const s = await enrolledStudent(app, course.id, `W${i}`);
    assert.equal((await joinWaitlist(app, s, [slot.id])).status, 201);
    waiting.push(s);
  }
  return { prof, course, slot, holder, waiting };
}

async function bookedBy(slotId) {
  const { rows } = await query('SELECT booked_by FROM office_hours WHERE id = $1', [slotId]);
  return rows[0].booked_by;
}

async function offerStatus(token) {
  return (await request(app).get(`/offers/${token}`)).body.status;
}

test('freeing a slot offers it to the first three in join order, by email', async () => {
  const { slot, holder, waiting } = await scenario(4);
  await cancelBooking(app, holder, slot.id);

  const { rows } = await query('SELECT o.rank, u.email FROM offers o JOIN users u ON u.id = o.student_id ORDER BY o.rank');
  assert.deepEqual(rows.map((r) => r.email), waiting.slice(0, 3).map((s) => s.email));
  for (const s of waiting.slice(0, 3)) assert.ok(await latestOfferToken(s.email), `${s.email} got an email`);
  assert.equal(await latestOfferToken(waiting[3].email), null, 'fourth is not asked yet');

  const offer = await request(app).get(`/offers/${await latestOfferToken(waiting[0].email)}`);
  assert.equal(offer.status, 200);
  assert.equal(offer.body.status, 'PENDING');
  assert.equal(offer.body.officeHour.location, 'BA 1234');
});

test('rank 1 says yes: booked immediately, others cancelled, winner leaves the waitlist', async () => {
  const { slot, holder, waiting } = await scenario(3);
  await cancelBooking(app, holder, slot.id);
  const [t1, t2] = await Promise.all([latestOfferToken(waiting[0].email), latestOfferToken(waiting[1].email)]);

  const res = await respond(app, t1, true);
  assert.deepEqual(res.body, { status: 'BOOKED' });
  assert.equal(await bookedBy(slot.id), waiting[0].user.id);
  assert.equal(await offerStatus(t2), 'CANCELLED');
  assert.equal((await respond(app, t2, true)).status, 410, 'round is over');

  const entries = await request(app).get('/student/waitlist').set('Authorization', waiting[0].auth);
  assert.deepEqual(entries.body, []);
  const won = await query("SELECT to_email FROM email_outbox WHERE subject LIKE 'You got%'");
  assert.deepEqual(won.rows.map((r) => r.to_email), [waiting[0].email]);
});

test('rank 2 says yes while rank 1 is pending: WAITING, then wins when rank 1 says no', async () => {
  const { slot, holder, waiting } = await scenario(3);
  await cancelBooking(app, holder, slot.id);
  const [t1, t2] = await Promise.all([latestOfferToken(waiting[0].email), latestOfferToken(waiting[1].email)]);

  assert.deepEqual((await respond(app, t2, true)).body, { status: 'WAITING' });
  assert.equal(await bookedBy(slot.id), null);
  assert.equal(await offerStatus(t2), 'WAITING');

  assert.deepEqual((await respond(app, t1, false)).body, { status: 'DECLINED' });
  assert.equal(await bookedBy(slot.id), waiting[1].user.id);
  assert.equal(await offerStatus(t2), 'BOOKED');
});

test('rank 2 says yes, rank 1 times out: the worker gives it to rank 2', async () => {
  const { slot, holder, waiting } = await scenario(3);
  await cancelBooking(app, holder, slot.id);
  await respond(app, await latestOfferToken(waiting[1].email), true);

  await expireRound(slot.id);
  assert.equal(await resolveDueRounds(), 1);
  assert.equal(await bookedBy(slot.id), waiting[1].user.id);
  assert.equal(await offerStatus(await latestOfferToken(waiting[0].email)), 'EXPIRED');
});

test('everyone says no: the next three are asked at once, never the same students again', async () => {
  const { slot, holder, waiting } = await scenario(5);
  await cancelBooking(app, holder, slot.id);
  for (const s of waiting.slice(0, 3)) await respond(app, await latestOfferToken(s.email), false);

  const { rows } = await query(
    `SELECT u.email, r.status FROM offers o JOIN users u ON u.id = o.student_id
       JOIN offer_rounds r ON r.id = o.round_id ORDER BY r.created_at, o.rank`,
  );
  assert.deepEqual(rows.slice(3).map((r) => [r.email, r.status]), [
    [waiting[3].email, 'OPEN'],
    [waiting[4].email, 'OPEN'],
  ]);
  assert.equal(rows[0].status, 'EXHAUSTED');
});

test('nobody answers and nobody is left: the slot becomes simply free', async () => {
  const { slot, holder, waiting } = await scenario(1);
  await cancelBooking(app, holder, slot.id);
  await expireRound(slot.id);
  await resolveDueRounds();
  assert.equal(await bookedBy(slot.id), null);
  const anyone = await enrolledStudentOfSameCourse(slot.id);
  assert.equal((await book(app, anyone, slot.id)).status, 201, 'bookable again');
  // The student who did not answer stays on the waitlist (rule 6).
  const entries = await request(app).get('/student/waitlist').set('Authorization', waiting[0].auth);
  assert.equal(entries.body.length, 1);
});

async function enrolledStudentOfSameCourse(slotId) {
  const { rows } = await query('SELECT course_id FROM office_hours WHERE id = $1', [slotId]);
  return enrolledStudent(app, rows[0].course_id);
}

test('answers are single use: second answer 409, unknown token 404, expired 410', async () => {
  const { slot, holder, waiting } = await scenario(3);
  await cancelBooking(app, holder, slot.id);
  const t2 = await latestOfferToken(waiting[1].email);
  const t3 = await latestOfferToken(waiting[2].email);

  assert.equal((await respond(app, t2, false)).status, 200);
  assert.equal((await respond(app, t2, true)).status, 409);
  assert.equal((await respond(app, 'not-a-real-token', true)).status, 404);
  assert.equal((await request(app).get('/offers/not-a-real-token')).status, 404);

  await expireRound(slot.id);
  assert.equal((await respond(app, t3, true)).status, 410, 'deadline passed, even before the worker ran');
  assert.equal((await respond(app, t3, 'yes')).status, 400);
});

test('"false" as a string is refused (400), never read as a yes', async () => {
  const { slot, holder, waiting } = await scenario(1);
  await cancelBooking(app, holder, slot.id);
  const res = await request(app).post(`/offers/${await latestOfferToken(waiting[0].email)}/respond`).send({ interested: 'false' });
  assert.equal(res.status, 400);
  assert.equal(await bookedBy(slot.id), null);
});

test('ranks 1 and 2 say yes at the same moment: rank 1 wins', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    await resetDatabase();
    const { slot, holder, waiting } = await scenario(2);
    await cancelBooking(app, holder, slot.id);
    const [t1, t2] = await Promise.all([latestOfferToken(waiting[0].email), latestOfferToken(waiting[1].email)]);
    const [r1, r2] = await Promise.all([respond(app, t1, true), respond(app, t2, true)]);
    assert.equal(r1.body.status, 'BOOKED');
    assert.ok(['WAITING', undefined].includes(r2.body.status) || r2.status === 410, `rank 2 got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.equal(await bookedBy(slot.id), waiting[0].user.id);
  }
});

test('two workers resolve the same due rounds at once: each round is resolved exactly once', async () => {
  // Several slots, each freed with someone who said yes at rank 2 and rank 1 silent.
  const prof = await loginAsNewProfessor(app);
  const course = await makeCourse(app, prof);
  const slots = [];
  for (let i = 0; i < 6; i++) {
    const slot = await makeSlot(app, prof, course.id, futureTime(3 + i, 15));
    const holder = await enrolledStudent(app, course.id);
    await book(app, holder, slot.id);
    const w1 = await enrolledStudent(app, course.id);
    const w2 = await enrolledStudent(app, course.id);
    await joinWaitlist(app, w1, [slot.id]);
    await joinWaitlist(app, w2, [slot.id]);
    await cancelBooking(app, holder, slot.id);
    await respond(app, await latestOfferToken(w2.email), true);
    await expireRound(slot.id);
    slots.push({ slot, w2 });
  }

  // Two independent workers, like two backend pods, on separate connections.
  const handled = await Promise.all([resolveDueRounds(), resolveDueRounds()]);
  assert.equal(handled[0] + handled[1], 6, `split ${handled}`);
  for (const { slot, w2 } of slots) assert.equal(await bookedBy(slot.id), w2.user.id);
  const awards = await query("SELECT count(*) AS n FROM offer_rounds WHERE status = 'AWARDED'");
  assert.equal(awards.rows[0].n, 6);
  const won = await query("SELECT count(*) AS n FROM email_outbox WHERE subject LIKE 'You got%'");
  assert.equal(won.rows[0].n, 6, 'one award email per slot, none twice');
});

test('a round survives a restart: state is only in PostgreSQL', async () => {
  const { slot, holder, waiting } = await scenario(2);
  await cancelBooking(app, holder, slot.id);
  await respond(app, await latestOfferToken(waiting[1].email), true);

  // "Restart": drop every connection and start a fresh pool, as a new pod would.
  await closePool();
  initPool({ ...databaseConfig() });
  await expireRound(slot.id);
  assert.equal(await resolveDueRounds(), 1);
  assert.equal(await bookedBy(slot.id), waiting[1].user.id);
});

test('one student wins two rounds the same day: the second offer is cancelled and moves on', async () => {
  const prof = await loginAsNewProfessor(app);
  const course = await makeCourse(app, prof);
  const a = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const b = await makeSlot(app, prof, course.id, futureTime(3, 16));
  const holderA = await enrolledStudent(app, course.id);
  const holderB = await enrolledStudent(app, course.id);
  await book(app, holderA, a.id);
  await book(app, holderB, b.id);
  const ana = await enrolledStudent(app, course.id, 'Ana');
  const bob = await enrolledStudent(app, course.id, 'Bob');
  await joinWaitlist(app, ana, [a.id, b.id]); // Ana first for both
  await joinWaitlist(app, bob, [b.id]);

  await cancelBooking(app, holderA, a.id);
  const anaA = await latestOfferToken(ana.email);
  await cancelBooking(app, holderB, b.id);
  const anaB = await latestOfferToken(ana.email);
  const bobB = await latestOfferToken(bob.email);
  assert.notEqual(anaA, anaB, 'two pending offers at once (rule 7 dropped)');

  await respond(app, bobB, true); // rank 2 for B, waits behind Ana
  assert.deepEqual((await respond(app, anaA, true)).body, { status: 'BOOKED' });
  assert.equal(await offerStatus(anaB), 'CANCELLED');

  await resolveDueRounds(); // B was flagged: Ana's cancel counts as no, Bob is next
  assert.equal(await bookedBy(b.id), bob.user.id);
});

test('professor cancels during a round: no award, no new round', async () => {
  const { prof, slot, holder, waiting } = await scenario(4);
  await cancelBooking(app, holder, slot.id);
  const t1 = await latestOfferToken(waiting[0].email);
  await request(app).delete(`/professor/office-hours/${slot.id}`).set('Authorization', prof.auth);

  assert.equal(await offerStatus(t1), 'CANCELLED');
  assert.equal((await respond(app, t1, true)).status, 410);
  const rounds = await query('SELECT status FROM offer_rounds');
  assert.deepEqual(rounds.rows.map((r) => r.status), ['CANCELLED']);
});

test('the offer deadline never runs past the slot start', async () => {
  const prof = await loginAsNewProfessor(app);
  const course = await makeCourse(app, prof);
  const soon = new Date(Date.now() + 2 * 60_000).toISOString(); // starts in 2 minutes
  const slot = await makeSlot(app, prof, course.id, soon);
  const holder = await enrolledStudent(app, course.id);
  const ana = await enrolledStudent(app, course.id);
  await book(app, holder, slot.id);
  await joinWaitlist(app, ana, [slot.id]);
  await cancelBooking(app, holder, slot.id);

  const offer = await request(app).get(`/offers/${await latestOfferToken(ana.email)}`);
  assert.ok(new Date(offer.body.expiresAt) <= new Date(soon), 'expires at the start, not 5 minutes later');
});

test('dropping a course frees my bookings for the waitlist and withdraws my entries', async () => {
  const prof = await loginAsNewProfessor(app);
  const course = await makeCourse(app, prof);
  const mine = await makeSlot(app, prof, course.id, futureTime(3, 15));
  const taken = await makeSlot(app, prof, course.id, futureTime(4, 15));
  const ana = await enrolledStudent(app, course.id, 'Ana');
  const bob = await enrolledStudent(app, course.id, 'Bob');
  const carl = await enrolledStudent(app, course.id, 'Carl');
  await book(app, ana, mine.id);
  await book(app, carl, taken.id);
  await joinWaitlist(app, ana, [taken.id]);
  await joinWaitlist(app, bob, [mine.id]);

  const enrollments = await request(app).get('/student/enrollments').set('Authorization', ana.auth);
  const res = await request(app).delete(`/student/enrollments/${enrollments.body[0].id}`).set('Authorization', ana.auth);
  assert.equal(res.status, 204);

  assert.equal(await bookedBy(mine.id), null);
  assert.ok(await latestOfferToken(bob.email), 'Bob is offered Ana\'s freed slot');
  const entries = await request(app).get('/student/waitlist').set('Authorization', ana.auth);
  assert.deepEqual(entries.body, []);
  assert.equal((await request(app).get('/student/enrollments').set('Authorization', ana.auth)).body.length, 0);
  assert.equal((await request(app).delete(`/student/enrollments/${enrollments.body[0].id}`).set('Authorization', ana.auth)).status, 404);
});
