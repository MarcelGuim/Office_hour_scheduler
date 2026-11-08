import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupTestApp, resetDatabase, loginAsNewProfessor, loginAsNewStudent } from './helpers.js';
import { closePool } from '../src/db.js';

let app;
before(async () => {
  app = await setupTestApp();
});
beforeEach(resetDatabase);
after(closePool);

function createCourse(prof, body) {
  return request(app).post('/professor/courses').set('Authorization', prof.auth).send(body);
}
function enroll(student, courseId) {
  return request(app).post('/student/enrollments').set('Authorization', student.auth).send({ courseId });
}

// ---- professor ----

test('professor creates a course; the code is stored uppercase', async () => {
  const prof = await loginAsNewProfessor(app);
  const res = await createCourse(prof, { code: ' ece1779 ', name: 'Cloud Computing' });
  assert.equal(res.status, 201);
  assert.equal(res.body.code, 'ECE1779');
  assert.equal(res.body.name, 'Cloud Computing');
  assert.ok(res.body.id);
});

test('duplicate course code is 409, whatever the capitals', async () => {
  const prof = await loginAsNewProfessor(app);
  assert.equal((await createCourse(prof, { code: 'ECE1779', name: 'A' })).status, 201);
  const res = await createCourse(prof, { code: 'ece1779', name: 'B' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'course code already exists' });
});

test('two simultaneous creates with the same code: exactly one wins', async () => {
  const prof = await loginAsNewProfessor(app);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => createCourse(prof, { code: 'ECE1779', name: 'Cloud' })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
});

test('course fields are validated', async () => {
  const prof = await loginAsNewProfessor(app);
  const bad = [
    [{ name: 'Cloud' }, 'code is required'],
    [{ code: 'ECE 1779', name: 'Cloud' }, 'code must be 2 to 20 letters, digits or hyphens, e.g. ECE1779'],
    [{ code: 'ECE1779', name: '   ' }, 'name must be 1 to 200 characters'],
  ];
  for (const [body, message] of bad) {
    const res = await createCourse(prof, body);
    assert.equal(res.status, 400, message);
    assert.deepEqual(res.body, { error: message });
  }
});

test('students cannot use professor routes (403); no token is 401', async () => {
  const student = await loginAsNewStudent(app);
  assert.equal((await createCourse(student, { code: 'ECE1779', name: 'Cloud' })).status, 403);
  assert.equal((await request(app).get('/professor/courses')).status, 401);
});

test('a professor lists only their own courses, with enrolled counts', async () => {
  const ada = await loginAsNewProfessor(app, 'Ada');
  const bob = await loginAsNewProfessor(app, 'Bob');
  const cloud = (await createCourse(ada, { code: 'ECE1779', name: 'Cloud' })).body;
  await createCourse(ada, { code: 'ECE1724', name: 'Bio' });
  await createCourse(bob, { code: 'CSC2125', name: 'Other' });

  await enroll(await loginAsNewStudent(app), cloud.id);
  await enroll(await loginAsNewStudent(app), cloud.id);

  const res = await request(app).get('/professor/courses').set('Authorization', ada.auth);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((c) => [c.code, c.enrolledCount]),
    [['ECE1724', 0], ['ECE1779', 2]],
  );
});

// ---- browse ----

test('browse lists every course with its professor, and search matches code or name', async () => {
  const ada = await loginAsNewProfessor(app, 'Ada');
  await createCourse(ada, { code: 'ECE1779', name: 'Cloud Computing' });
  await createCourse(ada, { code: 'CSC2125', name: 'Software 100% Tested' });
  const student = await loginAsNewStudent(app);

  const all = await request(app).get('/courses').set('Authorization', student.auth);
  assert.equal(all.status, 200);
  assert.equal(all.body.length, 2);
  assert.equal(all.body[0].professorName, 'Ada');

  const byName = await request(app).get('/courses?search=cloud').set('Authorization', student.auth);
  assert.deepEqual(byName.body.map((c) => c.code), ['ECE1779']);

  const padded = await request(app).get('/courses?search=%20cloud%20').set('Authorization', student.auth);
  assert.deepEqual(padded.body.map((c) => c.code), ['ECE1779'], 'search is trimmed');

  const byCode = await request(app).get('/courses?search=csc').set('Authorization', student.auth);
  assert.deepEqual(byCode.body.map((c) => c.code), ['CSC2125']);

  // % is a wildcard in SQL LIKE; it must be matched literally.
  const percent = await request(app).get('/courses?search=%25').set('Authorization', student.auth);
  assert.deepEqual(percent.body.map((c) => c.code), ['CSC2125']);

  assert.equal((await request(app).get('/courses')).status, 401);
});

// ---- enrollments ----

test('student enrolls and lists their courses; enrolling twice is 409', async () => {
  const prof = await loginAsNewProfessor(app);
  const course = (await createCourse(prof, { code: 'ECE1779', name: 'Cloud' })).body;
  const student = await loginAsNewStudent(app);

  const res = await enroll(student, course.id);
  assert.equal(res.status, 201);
  assert.equal(res.body.courseId, course.id);

  const again = await enroll(student, course.id);
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { error: 'already enrolled' });

  const list = await request(app).get('/student/enrollments').set('Authorization', student.auth);
  assert.deepEqual(list.body, [{ id: res.body.id, courseId: course.id, code: 'ECE1779', name: 'Cloud' }]);
});

test('enrolling in an unknown course is 404; a malformed id is 400; professors get 403', async () => {
  const student = await loginAsNewStudent(app);
  const missing = await enroll(student, '00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'course not found' });

  const malformed = await enroll(student, 'abc');
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: 'courseId must be a UUID' });

  const prof = await loginAsNewProfessor(app);
  assert.equal((await enroll(prof, '00000000-0000-4000-8000-000000000000')).status, 403);
});
