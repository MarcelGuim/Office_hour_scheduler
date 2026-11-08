// SQL for office_hours (slots). The booking lives here too: booked_by is the student
// (NULL = free). Every function takes an optional `db` (a transaction client).

import { getPool } from '../../db.js';

// One slot as the services use it.
const SLOT_SELECT = `
  SELECT oh.id, oh.course_id, oh.starts_at, oh.ends_at, oh.location, oh.cancelled,
         oh.booked_by, oh.session_date, c.code AS course_code, c.professor_id
    FROM office_hours oh
    JOIN courses c ON c.id = oh.course_id`;

function toSlot(row) {
  return {
    id: row.id,
    courseId: row.course_id,
    courseCode: row.course_code,
    professorId: row.professor_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    cancelled: row.cancelled,
    bookedBy: row.booked_by,
    sessionDate: row.session_date,
  };
}

export async function insertSlot({ courseId, startsAt, endsAt, location }, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO office_hours (course_id, starts_at, ends_at, location)
     VALUES ($1, $2, $3, $4)
     RETURNING id, course_id AS "courseId", starts_at AS "startsAt", ends_at AS "endsAt", location`,
    [courseId, startsAt, endsAt, location],
  );
  return rows[0];
}

export async function findSlot(id, db = getPool()) {
  const { rows } = await db.query(`${SLOT_SELECT} WHERE oh.id = $1`, [id]);
  return rows[0] ? toSlot(rows[0]) : null;
}

// Locks the slot row until the transaction ends. This lock is the lock for everything
// about the slot: its booking, its rounds and their offers (docs/design.md section 3).
export async function lockSlot(id, db) {
  const { rows } = await db.query(`${SLOT_SELECT} WHERE oh.id = $1 FOR UPDATE OF oh`, [id]);
  return rows[0] ? toSlot(rows[0]) : null;
}

// Several slots, always locked in id order so two transactions never wait in a circle.
export async function lockSlots(ids, db) {
  const { rows } = await db.query(
    `${SLOT_SELECT} WHERE oh.id = ANY($1::uuid[]) ORDER BY oh.id FOR UPDATE OF oh`,
    [ids],
  );
  return rows.map(toSlot);
}

// Book: only if still free. The unique index one_booking_per_session rejects a second
// booking of the same student, course and Toronto day (error 23505).
export async function setBookedBy(slotId, studentId, db) {
  const { rowCount } = await db.query(
    'UPDATE office_hours SET booked_by = $2 WHERE id = $1 AND booked_by IS NULL',
    [slotId, studentId],
  );
  return rowCount === 1;
}

export async function clearBookedBy(slotId, db) {
  await db.query('UPDATE office_hours SET booked_by = NULL WHERE id = $1', [slotId]);
}

export async function setCancelled(slotId, db) {
  await db.query('UPDATE office_hours SET cancelled = true WHERE id = $1', [slotId]);
}

// Does the student already hold a live booking in this course on this Toronto day?
export async function hasBookingInSession({ studentId, courseId, sessionDate }, db = getPool()) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM office_hours
      WHERE booked_by = $1 AND course_id = $2 AND session_date = $3 AND NOT cancelled`,
    [studentId, courseId, sessionDate],
  );
  return rowCount > 0;
}

export async function findUser(id, db = getPool()) {
  const { rows } = await db.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// The student's upcoming bookings in one course, locked (used when dropping the course).
export async function lockUpcomingBookings({ studentId, courseId }, db) {
  const { rows } = await db.query(
    `${SLOT_SELECT}
      WHERE oh.booked_by = $1 AND oh.course_id = $2 AND NOT oh.cancelled AND oh.starts_at > now()
      ORDER BY oh.id
      FOR UPDATE OF oh`,
    [studentId, courseId],
  );
  return rows.map(toSlot);
}

// ---- lists for the API ----

// Optional filters shared by the list queries: $2 course, $3 from, $4 to.
const FILTERS = `
  AND ($2::uuid IS NULL OR oh.course_id = $2)
  AND ($3::timestamptz IS NULL OR oh.starts_at >= $3)
  AND ($4::timestamptz IS NULL OR oh.starts_at < $4)`;

// slotId: optional, to fetch one slot in the same shape (GET /professor/office-hours/{id}).
export async function listProfessorSlots({ professorId, courseId, from, to, slotId }, db = getPool()) {
  const { rows } = await db.query(
    `SELECT oh.id, oh.course_id AS "courseId", c.code AS "courseCode",
            oh.starts_at AS "startsAt", oh.ends_at AS "endsAt", oh.location,
            oh.session_date AS "sessionDate", oh.cancelled,
            CASE WHEN u.id IS NULL THEN NULL
                 ELSE json_build_object('studentId', u.id, 'name', u.name) END AS "bookedBy",
            (SELECT count(*) FROM waitlist_entry_slots wes WHERE wes.office_hour_id = oh.id) AS waitlisted,
            (r.id IS NOT NULL) AS "offerRoundOpen"
       FROM office_hours oh
       JOIN courses c ON c.id = oh.course_id
       LEFT JOIN users u ON u.id = oh.booked_by
       LEFT JOIN offer_rounds r ON r.office_hour_id = oh.id AND r.status = 'OPEN'
      WHERE c.professor_id = $1 ${FILTERS}
        AND ($5::uuid IS NULL OR oh.id = $5)
      ORDER BY oh.starts_at`,
    [professorId, courseId ?? null, from ?? null, to ?? null, slotId ?? null],
  );
  return rows;
}

// Students waiting for this slot, in queue order.
export async function listWaitlistOfSlot(slotId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT we.student_id AS "studentId", u.name, we.joined_at AS "joinedAt"
       FROM waitlist_entry_slots wes
       JOIN waitlist_entries we ON we.id = wes.waitlist_entry_id
       JOIN users u ON u.id = we.student_id
      WHERE wes.office_hour_id = $1
      ORDER BY we.joined_at, we.id`,
    [slotId],
  );
  return rows;
}

// Upcoming, non-cancelled slots of the student's courses. No other students' names.
export async function listStudentSlots({ studentId, courseId, from, to }, db = getPool()) {
  const { rows } = await db.query(
    `SELECT oh.id, oh.course_id AS "courseId", c.code AS "courseCode",
            oh.starts_at AS "startsAt", oh.ends_at AS "endsAt", oh.location,
            oh.session_date AS "sessionDate",
            (oh.booked_by IS NULL AND r.id IS NULL) AS available,
            CASE WHEN oh.booked_by = $1 THEN 'BOOKED'
                 WHEN EXISTS (SELECT 1
                                FROM waitlist_entry_slots wes
                                JOIN waitlist_entries we ON we.id = wes.waitlist_entry_id
                               WHERE wes.office_hour_id = oh.id AND we.student_id = $1)
                 THEN 'WAITLISTED'
                 ELSE 'NONE' END AS "myStatus"
       FROM office_hours oh
       JOIN courses c ON c.id = oh.course_id
       JOIN enrollments e ON e.course_id = oh.course_id AND e.student_id = $1
       LEFT JOIN offer_rounds r ON r.office_hour_id = oh.id AND r.status = 'OPEN'
      WHERE NOT oh.cancelled AND oh.starts_at > now() ${FILTERS}
      ORDER BY oh.starts_at`,
    [studentId, courseId ?? null, from ?? null, to ?? null],
  );
  return rows;
}

// The student's bookings, newest first, including slots the professor cancelled
// (so the student can see that it happened).
export async function listStudentBookings(studentId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT oh.id, oh.id AS "officeHourId", c.code AS "courseCode",
            oh.starts_at AS "startsAt", oh.ends_at AS "endsAt", oh.location, oh.cancelled
       FROM office_hours oh
       JOIN courses c ON c.id = oh.course_id
      WHERE oh.booked_by = $1
      ORDER BY oh.starts_at DESC`,
    [studentId],
  );
  return rows;
}
