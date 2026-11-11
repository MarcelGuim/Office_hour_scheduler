// The offer-round engine (docs/design.md section 4).
//
// Every function that takes `client` runs inside the caller's transaction and expects
// the slot's row to be locked already (officeHours.model lockSlot). That lock is held
// until commit, so only one transaction at a time decides anything about a slot.

import { getConfig } from '../../config.js';
import { withTransaction } from '../../db.js';
import { HttpError } from '../../errors.js';
import { newToken, hashToken } from '../../tokens.js';
import { enqueueEmail } from '../../email/outbox.model.js';
import { offerEmail, awardedEmail } from '../../email/templates.js';
import * as offers from './offers.model.js';
import * as slots from '../officeHours/officeHours.model.js';
import * as waitlist from '../waitlist/waitlist.model.js';

const UNIQUE_VIOLATION = '23505';

function hasStarted(slot) {
  return new Date(slot.startsAt) <= new Date();
}

// A slot just became free. Asks the next students on its waitlist (up to the batch
// size): one offer and one email each. Returns the round, or null if nobody is waiting
// (the slot then stays simply free and bookable).
export async function openRound(client, slot) {
  if (slot.cancelled || slot.bookedBy || hasStarted(slot)) return null;
  if (await offers.findOpenRound(slot.id, client)) return null;

  const { offerBatchSize, offerWindowSeconds } = getConfig();
  const candidates = await waitlist.findCandidates(
    { slotId: slot.id, courseId: slot.courseId, sessionDate: slot.sessionDate, limit: offerBatchSize },
    client,
  );
  if (candidates.length === 0) return null;

  const round = await offers.insertRound({ slotId: slot.id, windowSeconds: offerWindowSeconds }, client);
  for (const [i, candidate] of candidates.entries()) {
    const token = newToken();
    await offers.insertOffer(
      {
        roundId: round.id,
        slotId: slot.id,
        entryId: candidate.entryId,
        studentId: candidate.studentId,
        rank: i + 1,
        tokenHash: hashToken(token), // only the hash is stored; the token goes in the email
      },
      client,
    );
    await enqueueEmail(
      offerEmail({ to: candidate.email, name: candidate.name, slot, token, expiresAt: round.expiresAt }),
      client,
    );
  }
  return round;
}

// Decides the slot's open round, if it can be decided now:
//   walk the offers by rank; the first YES wins, but only if everyone above it
//   answered NO, timed out or was cancelled. A PENDING above stops the walk (wait).
//   If nobody is left, the round is exhausted and the next round opens at once.
// Returns { status: 'WAITING' | 'AWARDED' | 'NEXT_ROUND' | 'EXHAUSTED' | 'CANCELLED' | 'NO_ROUND', offerId? }
export async function resolveRound(client, slotId) {
  const slot = await slots.lockSlot(slotId, client);
  const round = await offers.findOpenRound(slotId, client, { lock: true });
  if (!slot || !round) return { status: 'NO_ROUND' };

  if (slot.cancelled || slot.bookedBy || hasStarted(slot)) {
    await offers.expirePendingOffers(round.id, client);
    await offers.cancelLiveOffersOfRound(round.id, null, client);
    await offers.setRoundStatus(round.id, 'CANCELLED', client);
    return { status: 'CANCELLED' };
  }

  if (round.expired) await offers.expirePendingOffers(round.id, client);

  for (const offer of await offers.listOffersOfRound(round.id, client)) {
    if (offer.response === 'PENDING') {
      await offers.clearNeedsResolve(round.id, client);
      return { status: 'WAITING' };
    }
    if (offer.response === 'YES' && (await award(client, slot, round, offer))) {
      return { status: 'AWARDED', offerId: offer.id };
    }
    // NO, EXPIRED, CANCELLED, or a YES that could not be awarded: next rank.
  }

  await offers.setRoundStatus(round.id, 'EXHAUSTED', client);
  const next = await openRound(client, slot);
  return { status: next ? 'NEXT_ROUND' : 'EXHAUSTED' };
}

// Gives the slot to this offer's student, in the caller's transaction. Returns false
// if the student already holds an office hour of this course that day (the unique
// index refuses); the offer is then cancelled and the walk continues.
async function award(client, slot, round, offer) {
  // A savepoint lets the transaction survive the unique-index error.
  await client.query('SAVEPOINT award');
  try {
    const booked = await slots.setBookedBy(slot.id, offer.studentId, client);
    if (!booked) throw new Error(`slot ${slot.id} unexpectedly booked during an open round`);
    await client.query('RELEASE SAVEPOINT award');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT award');
    if (err.code !== UNIQUE_VIOLATION) throw err;
    await offers.setOfferCancelled(offer.id, client);
    return false;
  }
  await offers.setRoundStatus(round.id, 'AWARDED', client);
  await offers.cancelLiveOffersOfRound(round.id, offer.id, client);
  // The winner leaves the waitlist for this course and day; their other offers that
  // day are cancelled and those rounds move on.
  if (offer.entryId) await withdrawEntry(client, offer.entryId);
  await enqueueEmail(awardedEmail({ to: offer.email, name: offer.name, slot }), client);
  return true;
}

// Removes a waitlist entry: its live offers are cancelled (counted as NO) and their
// rounds flagged, so the worker resolves them within one interval. Flagging instead
// of resolving here avoids locking other slots in the middle of this transaction.
export async function withdrawEntry(client, entryId) {
  const roundIds = await offers.cancelLiveOffersOfEntry(entryId, client);
  await offers.flagRounds(roundIds, client);
  await waitlist.deleteEntry(entryId, client);
}

export async function withdrawEntryForSession(client, { studentId, courseId, sessionDate }) {
  const entry = await waitlist.findEntryForSession({ studentId, courseId, sessionDate }, client);
  if (entry) await withdrawEntry(client, entry.id);
}

// Professor cancelled the slot: the open round stops, nobody is awarded.
export async function stopRound(client, slotId) {
  const round = await offers.findOpenRound(slotId, client, { lock: true });
  if (!round) return;
  await offers.cancelLiveOffersOfRound(round.id, null, client);
  await offers.setRoundStatus(round.id, 'CANCELLED', client);
}

// ---- offer links (no JWT: the token is the credential) ----

export async function getOffer(token) {
  const offer = await offers.findOfferByTokenHash(hashToken(token));
  if (!offer) throw new HttpError(404, 'offer not found');
  return {
    officeHour: {
      courseCode: offer.courseCode,
      startsAt: offer.startsAt,
      endsAt: offer.endsAt,
      location: offer.location,
    },
    expiresAt: offer.expiresAt,
    status: offerStatus(offer),
  };
}

// PENDING: waiting for this student's answer. WAITING: said yes, higher ranks still
// deciding. BOOKED: won. DECLINED: said no. EXPIRED: no answer in time.
// CANCELLED: the slot went to someone else, was cancelled, or the student left.
function offerStatus(o) {
  if (o.response === 'YES' && o.roundStatus === 'AWARDED') return 'BOOKED';
  if (o.response === 'NO') return 'DECLINED';
  if (o.response === 'YES' && o.roundStatus === 'OPEN') return 'WAITING';
  if (o.response === 'PENDING' && o.roundStatus === 'OPEN' && !o.expired) return 'PENDING';
  if (o.response === 'EXPIRED' || o.response === 'PENDING') return 'EXPIRED';
  return 'CANCELLED';
}

// Answers an offer once. Returns { status: 'BOOKED' | 'WAITING' | 'DECLINED' | 'NOT_AWARDED' }.
export async function respond(token, interested) {
  const tokenHash = hashToken(token);
  const found = await offers.findOfferByTokenHash(tokenHash);
  if (!found) throw new HttpError(404, 'offer not found');

  return withTransaction(async (client) => {
    await slots.lockSlot(found.slotId, client);
    const offer = await offers.findOfferByTokenHash(tokenHash, client); // re-read under the lock
    if (offer.response === 'YES' || offer.response === 'NO') {
      throw new HttpError(409, 'offer already answered');
    }
    if (offer.response !== 'PENDING' || offer.roundStatus !== 'OPEN' || offer.expired) {
      throw new HttpError(410, 'offer expired or no longer available');
    }

    await offers.setOfferResponse(offer.id, interested ? 'YES' : 'NO', client);
    const result = await resolveRound(client, offer.slotId);

    if (!interested) return { status: 'DECLINED' };
    if (result.status === 'AWARDED' && result.offerId === offer.id) return { status: 'BOOKED' };
    const after = await offers.findOfferByTokenHash(tokenHash, client);
    return { status: after.response === 'YES' && after.roundStatus === 'OPEN' ? 'WAITING' : 'NOT_AWARDED' };
  });
}

// ---- worker ----

// One pass of the worker loop: resolves rounds whose deadline passed or that were
// flagged, one slot per transaction. Returns how many slots it handled.
export async function resolveDueRounds(max = 20) {
  let handled = 0;
  while (handled < max) {
    const didOne = await withTransaction(async (client) => {
      const slotId = await offers.lockNextDueSlotId(client);
      if (!slotId) return false;
      await resolveRound(client, slotId);
      return true;
    });
    if (!didOne) break;
    handled++;
  }
  return handled;
}
