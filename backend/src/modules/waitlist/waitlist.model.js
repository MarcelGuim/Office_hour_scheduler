// SQL for waitlist_entries and waitlist_entry_slots.
// An entry = one student, one session (course + Toronto day), one or more slots.

import { getPool } from '../../db.js';

export async function insertEntry({ studentId, courseId, sessionDate }, db) {
  const { rows } = await db.query(
    `INSERT INTO waitlist_entries (student_id, course_id, session_date)
     VALUES ($1, $2, $3)
     RETURNING id, joined_at AS "joinedAt"`,
    [studentId, courseId, sessionDate],
  );
  return rows[0];
}

export async function insertEntrySlots(entryId, slotIds, db) {
  await db.query(
    `INSERT INTO waitlist_entry_slots (waitlist_entry_id, office_hour_id)
     SELECT $1, unnest($2::uuid[])`,
    [entryId, slotIds],
  );
}

export async function findEntryOfStudent({ entryId, studentId }, db = getPool()) {
  const { rows } = await db.query(
    'SELECT id, course_id AS "courseId", session_date AS "sessionDate" FROM waitlist_entries WHERE id = $1 AND student_id = $2',
    [entryId, studentId],
  );
  return rows[0] || null;
}

export async function findEntryForSession({ studentId, courseId, sessionDate }, db = getPool()) {
  const { rows } = await db.query(
    'SELECT id FROM waitlist_entries WHERE student_id = $1 AND course_id = $2 AND session_date = $3',
    [studentId, courseId, sessionDate],
  );
  return rows[0] || null;
}

export async function listEntryIdsOfStudentInCourse({ studentId, courseId }, db = getPool()) {
  const { rows } = await db.query(
    'SELECT id FROM waitlist_entries WHERE student_id = $1 AND course_id = $2',
    [studentId, courseId],
  );
  return rows.map((r) => r.id);
}

export async function deleteEntry(entryId, db) {
  await db.query('DELETE FROM waitlist_entries WHERE id = $1', [entryId]);
}

// Professor cancelled a slot: take it out of every entry, then delete entries left empty.
export async function removeSlotFromAllEntries(slotId, db) {
  const { rows } = await db.query(
    'DELETE FROM waitlist_entry_slots WHERE office_hour_id = $1 RETURNING waitlist_entry_id',
    [slotId],
  );
  const entryIds = rows.map((r) => r.waitlist_entry_id);
  if (entryIds.length === 0) return [];
  const { rows: emptied } = await db.query(
    `SELECT we.id FROM waitlist_entries we
      WHERE we.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM waitlist_entry_slots s WHERE s.waitlist_entry_id = we.id)`,
    [entryIds],
  );
  return emptied.map((r) => r.id); // the caller withdraws these (cancels offers, deletes)
}

// Next students to ask for a freed slot: entries listing it, never offered it before,
// in queue order. The booking check is a safety net: entries are already removed
// when their student books in that session.
export async function findCandidates({ slotId, courseId, sessionDate, limit }, db) {
  const { rows } = await db.query(
    `SELECT we.id AS "entryId", we.student_id AS "studentId", u.name, u.email
       FROM waitlist_entry_slots wes
       JOIN waitlist_entries we ON we.id = wes.waitlist_entry_id
       JOIN users u ON u.id = we.student_id
      WHERE wes.office_hour_id = $1
        AND NOT EXISTS (SELECT 1 FROM offers o
                         WHERE o.waitlist_entry_id = we.id AND o.office_hour_id = $1)
        AND NOT EXISTS (SELECT 1 FROM office_hours b
                         WHERE b.booked_by = we.student_id AND b.course_id = $2
                           AND b.session_date = $3 AND NOT b.cancelled)
      ORDER BY we.joined_at, we.id
      LIMIT $4`,
    [slotId, courseId, sessionDate, limit],
  );
  return rows;
}

// The student's entries with their slots and whether an offer is waiting for an answer.
export async function listEntriesOfStudent(studentId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT we.id, we.course_id AS "courseId", c.code AS "courseCode",
            we.session_date AS "sessionDate", we.joined_at AS "joinedAt",
            coalesce(json_agg(json_build_object(
                       'id', oh.id, 'startsAt', oh.starts_at, 'endsAt', oh.ends_at,
                       'location', oh.location) ORDER BY oh.starts_at)
                     FILTER (WHERE oh.id IS NOT NULL), '[]') AS "officeHours",
            EXISTS (SELECT 1 FROM offers o JOIN offer_rounds r ON r.id = o.round_id
                     WHERE o.waitlist_entry_id = we.id AND o.response = 'PENDING'
                       AND r.status = 'OPEN' AND r.expires_at > now()) AS "offerPending"
       FROM waitlist_entries we
       JOIN courses c ON c.id = we.course_id
       LEFT JOIN waitlist_entry_slots wes ON wes.waitlist_entry_id = we.id
       LEFT JOIN office_hours oh ON oh.id = wes.office_hour_id
      WHERE we.student_id = $1
      GROUP BY we.id, c.code
      ORDER BY we.session_date, c.code`,
    [studentId],
  );
  return rows.map((r) => ({ ...r, officeHourIds: r.officeHours.map((s) => s.id) }));
}
