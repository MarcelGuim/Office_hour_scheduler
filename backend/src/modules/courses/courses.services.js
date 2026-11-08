// Course and enrollment rules. Duplicates are caught by the database's unique
// constraints (courses.code, enrollments(student_id, course_id)), not by a check
// before inserting: a check-then-insert would let two simultaneous requests both pass.

import { withTransaction } from '../../db.js';
import { HttpError } from '../../errors.js';
import * as model from './courses.model.js';
import * as slots from '../officeHours/officeHours.model.js';
import * as waitlist from '../waitlist/waitlist.model.js';
import * as rounds from '../offers/offers.services.js';

const UNIQUE_VIOLATION = '23505';

export async function createCourse({ code, name, professorId }) {
  try {
    return await model.insertCourse({ code, name, professorId });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'course code already exists');
    throw err;
  }
}

export function listMyCourses(professorId) {
  return model.listCoursesOfProfessor(professorId);
}

export function browseCourses(search) {
  return model.searchCourses(search);
}

export async function enroll({ studentId, courseId }) {
  const course = await model.findCourseById(courseId);
  if (!course) throw new HttpError(404, 'course not found');
  try {
    return await model.insertEnrollment({ studentId, courseId });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'already enrolled');
    throw err;
  }
}

export function listMyEnrollments(studentId) {
  return model.listEnrollmentsOfStudent(studentId);
}

// Drop a course: the student's waitlist entries for it are withdrawn (pending offers
// count as NO), their upcoming bookings are released, and each freed slot starts an
// offer round. Past bookings stay as history.
export async function dropCourse({ studentId, enrollmentId }) {
  await withTransaction(async (client) => {
    const enrollment = await model.lockEnrollmentOfStudent({ enrollmentId, studentId }, client);
    if (!enrollment) throw new HttpError(404, 'enrollment not found');
    const { courseId } = enrollment;

    for (const entryId of await waitlist.listEntryIdsOfStudentInCourse({ studentId, courseId }, client)) {
      await rounds.withdrawEntry(client, entryId);
    }
    // Locked in id order (lockUpcomingBookings) like every multi-slot operation.
    for (const slot of await slots.lockUpcomingBookings({ studentId, courseId }, client)) {
      await slots.clearBookedBy(slot.id, client);
      await rounds.openRound(client, { ...slot, bookedBy: null });
    }
    await model.deleteEnrollment(enrollment.id, client);
  });
}
