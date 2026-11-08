// SQL for the courses module: the courses and enrollments tables.
// Every function takes an optional `db` (a transaction client); default is the pool.

import { getPool } from '../../db.js';

// ---- courses ----

export async function insertCourse({ code, name, professorId }, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO courses (code, name, professor_id)
     VALUES ($1, $2, $3)
     RETURNING id, code, name`,
    [code, name, professorId],
  );
  return rows[0];
}

export async function findCourseById(id, db = getPool()) {
  const { rows } = await db.query(
    'SELECT id, code, name, professor_id FROM courses WHERE id = $1',
    [id],
  );
  if (!rows[0]) return null;
  const { professor_id: professorId, ...course } = rows[0];
  return { ...course, professorId };
}

// A professor's own courses, with how many students are enrolled in each.
export async function listCoursesOfProfessor(professorId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT c.id, c.code, c.name, count(e.id) AS "enrolledCount"
       FROM courses c
       LEFT JOIN enrollments e ON e.course_id = c.id
      WHERE c.professor_id = $1
      GROUP BY c.id
      ORDER BY c.code`,
    [professorId],
  );
  return rows;
}

// All courses, optionally filtered by a text that appears in the code or the name.
export async function searchCourses(search, db = getPool()) {
  const { rows } = await db.query(
    `SELECT c.id, c.code, c.name, u.name AS "professorName"
       FROM courses c
       JOIN users u ON u.id = c.professor_id
      WHERE $1::text IS NULL
         OR c.code ILIKE '%' || $1 || '%' ESCAPE '\\'
         OR c.name ILIKE '%' || $1 || '%' ESCAPE '\\'
      ORDER BY c.code`,
    [search === undefined ? null : escapeLike(search)],
  );
  return rows;
}

// In ILIKE, % and _ are wildcards. Escape them so searching "100%" means the text "100%".
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---- enrollments ----

export async function insertEnrollment({ studentId, courseId }, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO enrollments (student_id, course_id)
     VALUES ($1, $2)
     RETURNING id, course_id AS "courseId"`,
    [studentId, courseId],
  );
  return rows[0];
}

export async function listEnrollmentsOfStudent(studentId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT e.id, e.course_id AS "courseId", c.code, c.name
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
      WHERE e.student_id = $1
      ORDER BY c.code`,
    [studentId],
  );
  return rows;
}

// Used by the office-hours and waitlist modules: "is this student in this course?"
// Inside a transaction, FOR SHARE keeps the enrollment from being dropped until commit,
// so a booking can never outlive a drop that ran at the same moment.
export async function isEnrolled({ studentId, courseId }, db = getPool()) {
  const { rowCount } = await db.query(
    'SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 FOR SHARE',
    [studentId, courseId],
  );
  return rowCount > 0;
}

// The student's own enrollment, locked until the transaction ends (used when dropping).
export async function lockEnrollmentOfStudent({ enrollmentId, studentId }, db) {
  const { rows } = await db.query(
    `SELECT id, course_id AS "courseId" FROM enrollments
      WHERE id = $1 AND student_id = $2
      FOR UPDATE`,
    [enrollmentId, studentId],
  );
  return rows[0] || null;
}

export async function deleteEnrollment(enrollmentId, db) {
  await db.query('DELETE FROM enrollments WHERE id = $1', [enrollmentId]);
}
