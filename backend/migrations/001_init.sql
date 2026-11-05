-- 001_init.sql: initial schema. See docs/design.md section 2.
-- Requires PostgreSQL 13+ (gen_random_uuid is built in).


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
