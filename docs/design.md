# Application design

Status: draft for Marcel's review, 2026-11-05. Supersedes `api-reference.md` where they differ. Items marked **OPEN** need a decision.

## 1. Rules this design implements

- One student per office hour. Location is stored and shown to students.
- **Session** = one course on one calendar day in Toronto time. A student holds at most one booking per session.
- A waitlist entry belongs to one student, one session (course plus day), and lists one or more slots of that session. At most one entry per student per session.
- A student with a booking in a session cannot join that session's waitlist. Other days and other courses are fine.
- When a student gets a slot (direct booking or award), their entry for that session is deleted and its pending offers are cancelled. Their other entries stay the same.
- A slot that has started cannot be booked, offered or cancelled by the student.
- While an offer round is open, the slot is unavailable: direct booking returns 409, and students may join its waitlist.
- Professor cancellation: slot is cancelled, the booked student (if any) is emailed, any open round stops with no award, the slot is removed from waitlist entries.

## 2. Schema (migration `001_init.sql`)

```sql

CREATE TYPE user_role      AS ENUM ('PROFESSOR', 'STUDENT');
CREATE TYPE offer_response AS ENUM ('PENDING', 'YES', 'NO', 'EXPIRED', 'CANCELLED');
CREATE TYPE round_status   AS ENUM ('OPEN', 'AWARDED', 'EXHAUSTED', 'CANCELLED');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,           -- bcrypt, computed in Node
  role          user_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE courses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  professor_id uuid NOT NULL REFERENCES users(id)
);

CREATE TABLE enrollments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES users(id),
  course_id  uuid NOT NULL REFERENCES courses(id),
  UNIQUE (student_id, course_id)
);

CREATE TABLE office_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  location     text NOT NULL,
  cancelled    boolean NOT NULL DEFAULT false,
  booked_by    uuid REFERENCES users(id),           -- NULL = not booked
  session_date date GENERATED ALWAYS AS ((starts_at AT TIME ZONE 'America/Toronto')::date) STORED,
  CHECK (ends_at > starts_at)
);
-- Hard problem 1 and the per-session rule, both enforced by the database:
-- a slot has one booked_by column, and a student can hold one live booking per course per day.
CREATE UNIQUE INDEX one_booking_per_session
  ON office_hours (booked_by, course_id, session_date)
  WHERE booked_by IS NOT NULL AND NOT cancelled;
CREATE INDEX office_hours_course_time ON office_hours (course_id, starts_at);

CREATE TABLE waitlist_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id),
  course_id    uuid NOT NULL REFERENCES courses(id),
  session_date date NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, course_id, session_date)
);

CREATE TABLE waitlist_entry_slots (
  waitlist_entry_id uuid NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE,
  office_hour_id    uuid NOT NULL REFERENCES office_hours(id),
  PRIMARY KEY (waitlist_entry_id, office_hour_id)
);
CREATE INDEX waitlist_entry_slots_slot ON waitlist_entry_slots (office_hour_id);

CREATE TABLE offer_rounds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_hour_id uuid NOT NULL REFERENCES office_hours(id),
  status         round_status NOT NULL DEFAULT 'OPEN',
  expires_at     timestamptz NOT NULL,              -- least(now() + window, starts_at)
  needs_resolve  boolean NOT NULL DEFAULT false,    -- set when one of its offers was cancelled
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_open_round_per_slot ON offer_rounds (office_hour_id) WHERE status = 'OPEN';
CREATE INDEX offer_rounds_due ON offer_rounds (expires_at) WHERE status = 'OPEN';

CREATE TABLE offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id          uuid NOT NULL REFERENCES offer_rounds(id),
  office_hour_id    uuid NOT NULL REFERENCES office_hours(id),
  waitlist_entry_id uuid REFERENCES waitlist_entries(id) ON DELETE SET NULL,
  student_id        uuid NOT NULL REFERENCES users(id),
  rank              int  NOT NULL,
  response          offer_response NOT NULL DEFAULT 'PENDING',
  token_hash        text NOT NULL UNIQUE,           -- sha256 of the emailed token
  responded_at      timestamptz,
  UNIQUE (round_id, rank)
);
CREATE INDEX offers_entry ON offers (waitlist_entry_id);

CREATE TABLE email_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email        text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text
);
CREATE INDEX email_outbox_unsent ON email_outbox (next_attempt_at) WHERE sent_at IS NULL;

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

The migration runner creates `schema_migrations (filename text PRIMARY KEY, applied_at timestamptz)` itself.

Notes:
- `session_date` as a generated column was tested on `postgres:17` (2026-11-05): `2026-11-13T03:30Z` gives `2026-11-12`.
- `offers.office_hour_id` duplicates `offer_rounds.office_hour_id`. Kept because "was this entry already offered this slot" (rule 6) is then a single-table lookup.
- `offers.student_id` is kept because the entry is deleted when the student wins or leaves, but the round still needs its offers.
- An offer whose time ran out gets `EXPIRED` (new value). Without it, "no answer" and "PENDING" are indistinguishable in the data.

## 3. Locking rule (prevents deadlocks)

**The `office_hours` row is the lock for everything about that slot.** Every transaction that touches a slot, its round or its offers takes `SELECT ... FROM office_hours WHERE id = $1 FOR UPDATE` first, then the round. When a transaction needs several slots (dropping a course), it locks them in `id` order. All writes therefore queue on the same row in the same order, so two transactions never wait on each other in a circle. PostgreSQL also detects deadlocks (`40P01`); the transaction helper retries once on that error and on serialization failures.

## 4. Operations

All run in one transaction each.

### Book directly (`POST /student/bookings`)
1. Lock the slot. Check: exists (404), enrolled in its course (403), not cancelled and not started (400), `booked_by` is not me (409 already mine).
2. Unavailable if `booked_by IS NOT NULL` or an `OPEN` round exists: 409 `{"error":"taken","canJoinWaitlist":true}`.
3. `UPDATE office_hours SET booked_by = $me WHERE id = $slot`. A unique violation on `one_booking_per_session` means 409 `{"error":"already booked this session"}` (new error).
4. Delete my waitlist entry for this session, if any (see "remove an entry").

### Cancel my booking (`DELETE /student/bookings/{id}`)
`{id}` is the office hour id (bookings are no longer a table). Lock the slot; it must be booked by me (404 otherwise) and not started (400). Set `booked_by = NULL`, then **open a round**.

### Open a round (slot locked by the caller)
1. Stop if the slot is cancelled, booked, started, or already has an `OPEN` round.
2. Candidates: entries that list this slot and have no earlier offer for it, ordered by `joined_at, id`, limit `OFFER_BATCH_SIZE`.
3. None: stop. The slot is now simply free.
4. Insert the round with `expires_at = least(now() + OFFER_WINDOW, starts_at)`. For each candidate, generate a random 32-byte token in Node, store its sha256 in an offer with ranks 1..k, and insert an outbox email with the link `PUBLIC_BASE_URL/offer.html#<token>`.

### Respond (`POST /offers/{token}/respond`)
1. Find the offer by `sha256(token)` (404). Lock its slot, then its round.
2. `response <> 'PENDING'`: 409. Round not open or `expires_at <= now()`: 410.
3. Set `YES` or `NO`, then **resolve the round**. Return `BOOKED` if this offer won, `WAITING` if it said yes and is waiting on higher ranks, `DECLINED` for no.

### Resolve a round (slot and round locked)
1. If the slot has started or is cancelled: round `CANCELLED`, pending offers `EXPIRED`. Stop.
2. If `expires_at <= now()`, mark pending offers `EXPIRED`.
3. Walk offers by rank:
   - `YES`: **award** to it. Stop.
   - `PENDING`: stop and wait. A lower YES must wait for this one.
   - `NO`, `EXPIRED`, `CANCELLED`: continue.
4. If the walk finishes with no award, the round is `EXHAUSTED`. **Open a round** for the next candidates immediately.
5. Clear `needs_resolve`.

### Award (inside resolve)
1. Set `booked_by` to the winner. If the per-session unique index fails (the winner got another slot that day in the meantime), mark this offer `CANCELLED` and continue the walk.
2. Round `AWARDED`. Remaining pending offers of this round get `CANCELLED`.
3. Remove the winner's entry for this session (see below).
4. Queue a "you got the slot" email.

### Remove an entry (win, direct booking, leave, drop course)
Set the entry's `PENDING` and `YES` offers to `CANCELLED`, flag their rounds `needs_resolve = true`, then delete the entry. The worker resolves the flagged rounds within one poll interval. This avoids locking other slots in the middle of this transaction, which keeps the locking rule from section 3.

### Professor cancels (`DELETE /professor/office-hours/{id}`)
Lock the slot; set `cancelled = true`. If booked, email the student (`booked_by` is kept for the record; the partial index ignores cancelled slots). If a round is open, set it `CANCELLED` and its `PENDING`/`YES` offers `CANCELLED`, with no award and no new round. Delete the slot from `waitlist_entry_slots`, then delete entries left with no slots.

### Join the waitlist (`POST /student/waitlist`)
All slots must belong to one course and one `session_date` (400 otherwise), not be cancelled or started (400), and be unavailable (409 "a slot is free, book it"). The student must be enrolled (403), have no booking in that session (409), and have no entry for that session already (409, via the unique constraint). To change slots: leave and rejoin.

### Drop a course (`DELETE /student/enrollments/{id}`)
Lock my upcoming booked slots in that course (in id order). For each: release it and open a round. Remove my entries for that course. Delete the enrollment. Past bookings stay as history.

## 5. Background loops (in every backend pod)

A `setInterval` loop, every `WORKER_INTERVAL_MS` (default 2000):

1. **Rounds:**
   ```sql
   SELECT oh.id FROM office_hours oh
   JOIN offer_rounds r ON r.office_hour_id = oh.id AND r.status = 'OPEN'
   WHERE r.expires_at <= now() OR r.needs_resolve
   ORDER BY r.expires_at
   LIMIT 20
   FOR UPDATE OF oh SKIP LOCKED;
   ```
   It locks the slot (section 3 order), then resolves each round. Rows another pod has locked are skipped. Each slot is handled in its own transaction so one failure doesn't roll back the batch.
2. **Outbox:** `SELECT ... FROM email_outbox WHERE sent_at IS NULL AND next_attempt_at <= now() LIMIT 10 FOR UPDATE SKIP LOCKED`. For each row: send, then set `sent_at`. On failure: `attempts + 1`, back off `next_attempt_at`, record `last_error`. Delivery is at least once: if a pod dies after sending but before commit, that email is sent twice. This is accepted and documented.

State lives only in PostgreSQL, so a pod restart loses nothing. The next loop on any pod picks up overdue rounds.

## 6. Auth

- `POST /auth/register`: students only (a `role` in the body is ignored). Email stored lowercased. bcrypt (bcryptjs) cost 10 via `BCRYPT_COST`; password 8 characters to 72 bytes (bcrypt ignores bytes past 72).
- `POST /auth/login`: access JWT (HS256, 15 min, claims `sub`, `role`, `name`) in the body; refresh token in a cookie `refresh_token`: `httpOnly`, `SameSite=Strict`, `Path=/auth`, 7 days, `Secure` only when `COOKIE_SECURE=true` (HTTPS). Same 401 message for a wrong password and an unknown email, and an unknown email is checked against a dummy hash so the response time does not reveal which emails exist.
- `POST /auth/refresh`: rotation: the token is used up in one `UPDATE ... WHERE revoked_at IS NULL RETURNING`, so two concurrent uses cannot both succeed. A token used up more than 10 seconds ago and presented again is treated as stolen: all of that user's refresh tokens are revoked. Within 10 seconds it is treated as two tabs racing and just gets 401.
- `POST /auth/logout`: revokes the current refresh token and clears the cookie; always 204. Access JWTs stay valid until they expire (at most 15 min). Accepted and documented.
- `requireAuth` / `requireRole(role)` in `modules/auth/auth.middleware.js` guard the other modules' routes: 401 for a missing or bad token, 403 for the wrong role.
- Professors: `scripts/seed-professors.js` reads `SEED_PROFESSORS`, a JSON array of `{name, email, password}`, from the environment (`.env` locally, a Kubernetes Secret in the cluster). Re-running updates name and password; an email that belongs to a student is refused. Nothing secret is committed.
- `JWT_SECRET` must be at least 32 characters; the app refuses to start otherwise.

## 7. Endpoints (24)

The same as `api-reference.md` except as listed here. Swagger (`/docs`) is the exact, current reference.
- Added `POST /auth/refresh` and `POST /auth/logout`.
- `POST /auth/register`: `role` and `inviteCode` removed (students only).
- Office hours gain `location`: in the create request, the professor views and the student view. Lists also return `sessionDate` (the Toronto day) and `courseCode`; the professor list returns `offerRoundOpen`.
- `POST /professor/office-hours`: times must be ISO 8601 with a zone (`Z` or `+hh:mm`).
- `DELETE /professor/office-hours/{id}`: 400 if the slot has started; cancelling twice is 204.
- `POST /student/bookings`: new 409 for already booked this session. `{id}` in `DELETE /student/bookings/{id}` is the office hour id; the booking `id` in responses equals `officeHourId`. `GET /student/bookings` includes past bookings and ones the professor cancelled (`cancelled: true`).
- `POST /student/waitlist`: 400 when the slots span courses or days; 409 when I already have a booking or an entry that day. `GET /student/waitlist` also returns `courseId`, `courseCode`, `sessionDate` and `officeHours` (the slots).
- `GET /offers/{token}`: always 200 for a known token (404 unknown), with `status` one of `PENDING`, `WAITING` (said yes, higher ranks still deciding), `BOOKED`, `DECLINED`, `EXPIRED`, `CANCELLED`. The proposal's 410 moved to `respond`.
- `POST /offers/{token}/respond`: `interested` must be a JSON boolean. Result `BOOKED`, `WAITING`, `DECLINED`, or `NOT_AWARDED` (said yes but could not get it). 409 already answered; 410 expired, cancelled or round closed.
- `GET /health`: checks the database, so use it as the **readiness** probe only. If liveness used it too, a database outage would restart every backend pod. Liveness should be a plain TCP or process check (note for Andrew).
- Local testing only, not counted: `GET /dev/mailbox` (enabled by `DEV_MAILBOX=true`, which only `docker-compose.yml` sets) lists queued emails for `/mailbox.html`.

## 8. Configuration (environment variables)

`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (separate fields, no URL, so the password needs no escaping), `JWT_SECRET`, `OFFER_BATCH_SIZE=3`, `OFFER_WINDOW_SECONDS=300`, `WORKER_INTERVAL_MS=2000`, `PUBLIC_BASE_URL`, `SMTP_USER`, `SMTP_APP_PASSWORD`, `COOKIE_SECURE=false`, `PORT=8080`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `EMAIL_FROM`, `OUTBOX_INTERVAL_MS=2000`, `DEV_MAILBOX=false`, `ACCESS_TOKEN_TTL_SECONDS=900`, `REFRESH_TOKEN_TTL_DAYS=7`, `BCRYPT_COST=10`. Seed script only: `SEED_PROFESSORS`.

## 9. Code layout

One folder per module. Each request goes routes → controller → service → model → PostgreSQL.

| File | Job | Must not |
|---|---|---|
| `X.routes.js` | URL, Swagger comment, validation middleware, then the controller | contain logic |
| `X.validation.js` | express-validator rules for the request's shape (fields, formats, UUIDs, time order); ends with the shared `validate` (400 `{"error"}`) | touch the database |
| `X.controller.js` | read `req`, call the service, pick the status code and body | contain SQL or rules |
| `X.services.js` | rules that need data ("slot taken", "not enrolled"), transactions via `withTransaction`; throws `HttpError` | know about `req`/`res` |
| `X.model.js` | the SQL for its tables, and row → API object mapping (`starts_at` → `startsAt`); functions take an optional transaction `client` | contain rules |

```
backend/
  package.json  Dockerfile
  migrations/001_init.sql
  scripts/migrate.js  scripts/seed-professors.js
  src/
    server.js       start HTTP server and loops, graceful shutdown on SIGTERM
    app.js          Express app (exported for tests); mounts every module's routes
    config.js       environment variables
    db.js           pool + withTransaction helper with retry
    errors.js       HttpError and the {"error"} handler
    validation.js   shared `validate` middleware for express-validator
    swagger.js      Swagger UI at /docs, OpenAPI JSON at /docs.json
    modules/
      health/       routes, controller, services, model (no validation: no input)
      auth/         register, login, refresh, logout; JWT middleware (requireRole)
      courses/      professor courses, browse, enrollments (incl. drop cascade)
      officeHours/  professor slots, student view, bookings
      waitlist/     join, list, leave
      offers/       rounds (open/resolve/award), offer links, worker loop
    email/          mailer + outbox loop
  public/           plain HTML + JS frontend
  test/
docker-compose.yml  (postgres, migrate, backend)
k8s/                Andrew
```

URLs stay as designed (`/professor/...`, `/student/...`); modules are split by domain, not by role, because one process (for example cancel → offer round → award) spans roles.

## 10. Tests (against a real PostgreSQL)

Tests run on a separate database, `<DB_NAME>_test`, on the Compose PostgreSQL (`test/helpers.js` creates and migrates it, and empties it before each file). Run with `cd backend && npm test` while `docker compose up -d postgres` is running.

The plan is Node's built-in `node:test` plus `supertest`, with no other framework. **OPEN:** tell me if you'd rather use Jest.

Concurrency tests (required):
1. 50 parallel `POST /student/bookings` for one slot from 50 students: exactly one 201, 49 × 409.
2. One student books two slots of the same session in parallel: exactly one succeeds.
3. A cancel and a direct booking at the same moment: the booking gets 409 (round open) or the round finds nothing. Never both.
4. Rank 1 and rank 2 answer YES at the same moment: rank 1 wins.
5. Two worker instances run against the same due rounds: each round is resolved exactly once (count awards and new rounds).
6. One student wins two rounds of the same session at once: one award, and the other offer is `CANCELLED` and passes to the next student.

Functional tests: every rule in section 1 and every row of the offer walk, using a 2-second window. Restart test: open a round, stop the app, wait past expiry, start the app, and the round resolves. In the cluster: delete a backend pod mid-round, and delete the PostgreSQL pod, with no data lost.
