// SQL for offer_rounds and offers (docs/schema.md section 4).
// Callers hold the slot's row lock (lockSlot) before touching its round or offers.

import { getPool } from '../../db.js';

// ---- rounds ----

export async function findOpenRound(slotId, db = getPool(), { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, expires_at AS "expiresAt", (expires_at <= now()) AS expired
       FROM offer_rounds
      WHERE office_hour_id = $1 AND status = 'OPEN'
      ${lock ? 'FOR UPDATE' : ''}`,
    [slotId],
  );
  return rows[0] || null;
}

// The deadline never runs past the slot's start.
export async function insertRound({ slotId, windowSeconds }, db) {
  const { rows } = await db.query(
    `INSERT INTO offer_rounds (office_hour_id, expires_at)
     SELECT id, least(now() + make_interval(secs => $2), starts_at)
       FROM office_hours WHERE id = $1
     RETURNING id, expires_at AS "expiresAt"`,
    [slotId, windowSeconds],
  );
  return rows[0];
}

export async function setRoundStatus(roundId, status, db) {
  await db.query('UPDATE offer_rounds SET status = $2, needs_resolve = false WHERE id = $1', [roundId, status]);
}

export async function clearNeedsResolve(roundId, db) {
  await db.query('UPDATE offer_rounds SET needs_resolve = false WHERE id = $1', [roundId]);
}

// "Please look at this round again": one of its offers was cancelled from outside.
export async function flagRounds(roundIds, db) {
  if (roundIds.length === 0) return;
  await db.query(
    "UPDATE offer_rounds SET needs_resolve = true WHERE id = ANY($1::uuid[]) AND status = 'OPEN'",
    [roundIds],
  );
}

// Worker: one slot whose open round is due (deadline passed or flagged), locked.
// SKIP LOCKED: a slot another pod (or a request) is working on is skipped, not waited for.
export async function lockNextDueSlotId(db) {
  const { rows } = await db.query(
    `SELECT oh.id
       FROM office_hours oh
       JOIN offer_rounds r ON r.office_hour_id = oh.id AND r.status = 'OPEN'
      WHERE r.expires_at <= now() OR r.needs_resolve
      ORDER BY r.expires_at
      LIMIT 1
      FOR UPDATE OF oh SKIP LOCKED`,
  );
  return rows[0] ? rows[0].id : null;
}

// ---- offers ----

export async function insertOffer({ roundId, slotId, entryId, studentId, rank, tokenHash }, db) {
  await db.query(
    `INSERT INTO offers (round_id, office_hour_id, waitlist_entry_id, student_id, rank, token_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [roundId, slotId, entryId, studentId, rank, tokenHash],
  );
}

export async function listOffersOfRound(roundId, db) {
  const { rows } = await db.query(
    `SELECT o.id, o.rank, o.response, o.student_id AS "studentId",
            o.waitlist_entry_id AS "entryId", u.name, u.email
       FROM offers o JOIN users u ON u.id = o.student_id
      WHERE o.round_id = $1
      ORDER BY o.rank`,
    [roundId],
  );
  return rows;
}

export async function expirePendingOffers(roundId, db) {
  await db.query(
    "UPDATE offers SET response = 'EXPIRED' WHERE round_id = $1 AND response = 'PENDING'",
    [roundId],
  );
}

export async function setOfferResponse(offerId, response, db) {
  await db.query('UPDATE offers SET response = $2, responded_at = now() WHERE id = $1', [offerId, response]);
}

export async function setOfferCancelled(offerId, db) {
  await db.query("UPDATE offers SET response = 'CANCELLED' WHERE id = $1", [offerId]);
}

// Round closed: every offer still in play (PENDING or YES), except the winner's, is cancelled.
export async function cancelLiveOffersOfRound(roundId, exceptOfferId, db) {
  await db.query(
    `UPDATE offers SET response = 'CANCELLED'
      WHERE round_id = $1 AND response IN ('PENDING', 'YES')
        AND ($2::uuid IS NULL OR id <> $2)`,
    [roundId, exceptOfferId ?? null],
  );
}

// An entry is withdrawn: cancel its live offers in open rounds, and return those
// rounds so they can be flagged for the worker.
export async function cancelLiveOffersOfEntry(entryId, db) {
  const { rows } = await db.query(
    `UPDATE offers o SET response = 'CANCELLED'
       FROM offer_rounds r
      WHERE r.id = o.round_id AND r.status = 'OPEN'
        AND o.waitlist_entry_id = $1 AND o.response IN ('PENDING', 'YES')
      RETURNING o.round_id`,
    [entryId],
  );
  return [...new Set(rows.map((r) => r.round_id))];
}

// The offer behind an emailed token, with its round and slot (no lock: used to find
// which slot to lock, and for the read-only offer page).
export async function findOfferByTokenHash(tokenHash, db = getPool()) {
  const { rows } = await db.query(
    `SELECT o.id, o.response, o.student_id AS "studentId", o.round_id AS "roundId",
            o.office_hour_id AS "slotId", r.status AS "roundStatus",
            r.expires_at AS "expiresAt", (r.expires_at <= now()) AS expired,
            oh.booked_by AS "bookedBy", oh.starts_at AS "startsAt", oh.ends_at AS "endsAt",
            oh.location, c.code AS "courseCode"
       FROM offers o
       JOIN offer_rounds r ON r.id = o.round_id
       JOIN office_hours oh ON oh.id = o.office_hour_id
       JOIN courses c ON c.id = oh.course_id
      WHERE o.token_hash = $1`,
    [tokenHash],
  );
  return rows[0] || null;
}
