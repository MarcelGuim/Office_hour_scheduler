// Office-hour rules: professors create and cancel slots; students book and cancel.
// Booking and cancelling lock the slot row first (docs/design.md section 3).

import { withTransaction } from '../../db.js';
import { HttpError } from '../../errors.js';
import { enqueueEmail } from '../../email/outbox.model.js';
import { professorCancelledEmail } from '../../email/templates.js';
import * as model from './officeHours.model.js';
import * as courses from '../courses/courses.model.js';
import * as offers from '../offers/offers.model.js';
import * as rounds from '../offers/offers.services.js';
import * as waitlist from '../waitlist/waitlist.model.js';

const UNIQUE_VIOLATION = '23505';

function hasStarted(slot) {
  return new Date(slot.startsAt) <= new Date();
}

// ---- professor ----

export async function createSlot({ professorId, courseId, startsAt, endsAt, location }) {
  const course = await courses.findCourseById(courseId);
  if (!course) throw new HttpError(404, 'course not found');
  if (course.professorId !== professorId) throw new HttpError(403, 'not your course');
  if (new Date(startsAt) <= new Date()) throw new HttpError(400, 'startsAt must be in the future');
  return model.insertSlot({ courseId, startsAt, endsAt, location });
}

export function listProfessorSlots({ professorId, courseId, from, to }) {
  return model.listProfessorSlots({ professorId, courseId, from, to });
}

async function findOwnSlot(professorId, slotId, db) {
  const slot = db ? await model.lockSlot(slotId, db) : await model.findSlot(slotId);
  if (!slot) throw new HttpError(404, 'office hour not found');
  if (slot.professorId !== professorId) throw new HttpError(403, 'not your office hour');
  return slot;
}

export async function getProfessorSlot({ professorId, slotId }) {
  await findOwnSlot(professorId, slotId);
  const [slot] = await model.listProfessorSlots({ professorId, slotId });
  return { ...slot, waitlist: await model.listWaitlistOfSlot(slotId) };
}

// Cancels the slot: the booked student is emailed, an open offer round stops without
// an award, and the slot leaves every waitlist entry. No new offers are sent.
export async function cancelSlot({ professorId, slotId }) {
  await withTransaction(async (client) => {
    const slot = await findOwnSlot(professorId, slotId, client);
    if (slot.cancelled) return; // already cancelled: nothing to do (still 204)
    if (hasStarted(slot)) throw new HttpError(400, 'office hour has already started');

    await model.setCancelled(slot.id, client);
    if (slot.bookedBy) {
      const student = await model.findUser(slot.bookedBy, client);
      await enqueueEmail(professorCancelledEmail({ to: student.email, name: student.name, slot }), client);
    }
    await rounds.stopRound(client, slot.id);
    const emptied = await waitlist.removeSlotFromAllEntries(slot.id, client);
    for (const entryId of emptied) await rounds.withdrawEntry(client, entryId);
  });
}

// ---- student ----

export function listStudentSlots({ studentId, courseId, from, to }) {
  return model.listStudentSlots({ studentId, courseId, from, to });
}

export function listStudentBookings(studentId) {
  return model.listStudentBookings(studentId);
}

// Hard problem 1: two students click the last slot at once. Both transactions try to
// lock the same row; the second waits, then sees booked_by set and gets 409.
export async function book({ studentId, slotId }) {
  return withTransaction(async (client) => {
    const slot = await model.lockSlot(slotId, client);
    if (!slot) throw new HttpError(404, 'office hour not found');
    if (!(await courses.isEnrolled({ studentId, courseId: slot.courseId }, client))) {
      throw new HttpError(403, 'not enrolled in this course');
    }
    if (slot.cancelled) throw new HttpError(400, 'office hour was cancelled');
    if (hasStarted(slot)) throw new HttpError(400, 'office hour has already started');
    if (slot.bookedBy === studentId) throw new HttpError(409, 'you already booked this office hour');
    // Taken, or free but offered to the waitlist right now (an open round): unavailable.
    if (slot.bookedBy || (await offers.findOpenRound(slot.id, client))) {
      throw new HttpError(409, 'taken', { canJoinWaitlist: true });
    }

    try {
      await model.setBookedBy(slot.id, studentId, client);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        throw new HttpError(409, 'you already have an office hour for this course on this day');
      }
      throw err;
    }
    // Booked directly: leave this day's waitlist for the course (other days stay).
    await rounds.withdrawEntryForSession(client, {
      studentId,
      courseId: slot.courseId,
      sessionDate: slot.sessionDate,
    });
    return { id: slot.id, officeHourId: slot.id };
  });
}

// Frees the slot and, if anyone is waiting, opens an offer round in the same transaction.
export async function cancelBooking({ studentId, slotId }) {
  await withTransaction(async (client) => {
    const slot = await model.lockSlot(slotId, client);
    if (!slot || slot.bookedBy !== studentId || slot.cancelled) {
      throw new HttpError(404, 'booking not found');
    }
    if (hasStarted(slot)) throw new HttpError(400, 'office hour has already started');
    await model.clearBookedBy(slot.id, client);
    await rounds.openRound(client, { ...slot, bookedBy: null });
  });
}
