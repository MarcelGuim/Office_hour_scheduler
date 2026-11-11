// Waitlist rules. An entry covers one course on one Toronto day and lists the taken
// slots the student would accept (any one will do).

import { withTransaction } from '../../db.js';
import { HttpError } from '../../errors.js';
import * as model from './waitlist.model.js';
import * as slotsModel from '../officeHours/officeHours.model.js';
import * as courses from '../courses/courses.model.js';
import * as offers from '../offers/offers.model.js';
import * as rounds from '../offers/offers.services.js';

const UNIQUE_VIOLATION = '23505';

export async function join({ studentId, officeHourIds }) {
  return withTransaction(async (client) => {
    // Locking the slots (in id order) means none of them can be freed or booked while
    // we check them, so "every slot is taken" stays true until we commit.
    const slots = await slotsModel.lockSlots(officeHourIds, client);
    if (slots.length !== officeHourIds.length) throw new HttpError(404, 'office hour not found');

    const { courseId, sessionDate } = slots[0];
    if (slots.some((s) => s.courseId !== courseId || s.sessionDate !== sessionDate)) {
      throw new HttpError(400, 'all office hours must be of the same course and day');
    }
    if (!(await courses.isEnrolled({ studentId, courseId }, client))) {
      throw new HttpError(403, 'not enrolled in this course');
    }
    const now = new Date();
    if (slots.some((s) => s.cancelled || new Date(s.startsAt) <= now)) {
      throw new HttpError(400, 'an office hour was cancelled or has already started');
    }
    if (slots.some((s) => s.bookedBy === studentId)) {
      throw new HttpError(409, 'you already booked one of these office hours');
    }
    for (const s of slots) {
      if (!s.bookedBy && !(await offers.findOpenRound(s.id, client))) {
        throw new HttpError(409, 'an office hour is free: book it instead');
      }
    }
    if (await slotsModel.hasBookingInSession({ studentId, courseId, sessionDate }, client)) {
      throw new HttpError(409, 'you already have an office hour for this course on this day');
    }

    let entry;
    try {
      entry = await model.insertEntry({ studentId, courseId, sessionDate }, client);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        throw new HttpError(409, 'you are already on the waitlist for this course on this day');
      }
      throw err;
    }
    await model.insertEntrySlots(entry.id, officeHourIds, client);
    return { id: entry.id, courseId, sessionDate, officeHourIds, joinedAt: entry.joinedAt };
  });
}

export function listMyEntries(studentId) {
  return model.listEntriesOfStudent(studentId);
}

// Leaving withdraws the whole entry: its pending offers count as NO.
export async function leave({ studentId, entryId }) {
  await withTransaction(async (client) => {
    const entry = await model.findEntryOfStudent({ entryId, studentId }, client);
    if (!entry) throw new HttpError(404, 'waitlist entry not found');
    await rounds.withdrawEntry(client, entry.id);
  });
}
