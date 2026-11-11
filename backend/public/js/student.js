import { api, requireUser, logout } from './api.js';
import { el, replace, attempt, badge, emptyRow } from './ui.js';
import { formatRange, formatDay } from './time.js';

const user = await requireUser('STUDENT');
document.getElementById('who').textContent = `· ${user.name}`;
document.getElementById('logout').addEventListener('click', logout);
document.getElementById('slot-course').addEventListener('change', loadSlots);
document.getElementById('search').addEventListener('submit', (event) => {
  event.preventDefault();
  loadCourses(new FormData(event.target).get('search'));
});

let enrolledIds = new Set();

async function reloadAll() {
  await loadEnrollments();
  await Promise.all([loadSlots(), loadBookings(), loadWaitlist(), loadCourses()]);
}

// ---- courses ----

async function loadEnrollments() {
  const enrollments = await api('GET', '/student/enrollments');
  enrolledIds = new Set(enrollments.map((e) => e.courseId));

  const select = document.getElementById('slot-course');
  const selected = select.value;
  replace(select, el('option', { value: '' }, 'All my courses'),
    enrollments.map((e) => el('option', { value: e.courseId, selected: e.courseId === selected }, e.code)));

  replace(document.getElementById('enrollments'), enrollments.length === 0
    ? emptyRow('You are not enrolled in any course yet. Find one below.')
    : el('table', {}, enrollments.map((e) => el('tr', {},
        el('td', {}, el('strong', {}, e.code)), el('td', {}, e.name),
        el('td', { class: 'actions' }, el('button', {
          class: 'danger',
          onclick: () => drop(e),
        }, 'Drop'))))));
}

async function drop(enrollment) {
  if (!confirm(`Drop ${enrollment.code}? Your bookings and waitlist entries for it are released.`)) return;
  if (await attempt(() => api('DELETE', `/student/enrollments/${enrollment.id}`), `Dropped ${enrollment.code}`)) {
    await reloadAll();
  }
}

async function loadCourses(search = '') {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  const courses = await api('GET', `/courses${query}`);
  replace(document.getElementById('courses'), courses.length === 0
    ? emptyRow('No courses found.')
    : el('table', {}, courses.map((c) => el('tr', {},
        el('td', {}, el('strong', {}, c.code)), el('td', {}, c.name), el('td', { class: 'muted' }, c.professorName),
        el('td', { class: 'actions' }, enrolledIds.has(c.id)
          ? badge('Enrolled', 'ok')
          : el('button', { onclick: () => enroll(c) }, 'Enroll'))))));
}

async function enroll(course) {
  if (await attempt(() => api('POST', '/student/enrollments', { courseId: course.id }), `Enrolled in ${course.code}`)) {
    await reloadAll();
  }
}

// ---- office hours ----

async function loadSlots() {
  const courseId = document.getElementById('slot-course').value;
  const slots = await api('GET', `/student/office-hours${courseId ? `?courseId=${courseId}` : ''}`);
  const container = document.getElementById('slots');
  if (slots.length === 0) return replace(container, emptyRow('No upcoming office hours.'));

  // Group by course and Toronto day: a waitlist entry covers one course on one day.
  const groups = new Map();
  for (const s of slots) {
    const key = `${s.sessionDate}|${s.courseId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  replace(container, [...groups.values()].map(slotGroup));
}

function slotGroup(slots) {
  const { sessionDate, courseCode } = slots[0];
  const checks = [];
  const bookedHere = slots.some((s) => s.myStatus === 'BOOKED');
  const rows = slots.map((s) => {
    let status;
    let action = null;
    if (s.myStatus === 'BOOKED') {
      status = badge('Booked by you', 'ok');
      action = el('button', { class: 'danger', onclick: () => cancelBooking(s) }, 'Cancel');
    } else if (s.myStatus === 'WAITLISTED') {
      status = badge('On your waitlist', 'warn');
    } else if (s.available) {
      status = badge('Free', 'ok');
      action = el('button', { onclick: () => book(s), disabled: bookedHere }, 'Book');
    } else {
      status = badge('Taken');
      if (!bookedHere) {
        const box = el('input', { type: 'checkbox', value: s.id, title: 'Include in waitlist' });
        checks.push(box);
        action = el('label', { class: 'row' }, box, 'waitlist');
      }
    }
    return el('tr', {}, el('td', {}, formatRange(s.startsAt, s.endsAt)), el('td', {}, s.location),
      el('td', {}, status), el('td', { class: 'actions' }, action));
  });

  const joinButton = checks.length > 0
    ? el('button', { class: 'secondary', onclick: () => joinWaitlist(checks) }, 'Join waitlist with ticked slots')
    : null;
  return el('div', {},
    el('h3', {}, `${courseCode} · ${formatDay(sessionDate)}`, bookedHere ? ' · you have an office hour this day' : ''),
    el('table', {}, rows),
    joinButton && el('div', { class: 'row' }, joinButton));
}

async function book(slot) {
  const ok = await attempt(() => api('POST', '/student/bookings', { officeHourId: slot.id }), 'Booked');
  await reloadAll();
  return ok;
}

async function cancelBooking(slot) {
  if (!confirm('Cancel this booking? If students are waiting, it is offered to them.')) return;
  if (await attempt(() => api('DELETE', `/student/bookings/${slot.officeHourId || slot.id}`), 'Booking cancelled')) {
    await reloadAll();
  }
}

async function joinWaitlist(checks) {
  const officeHourIds = checks.filter((c) => c.checked).map((c) => c.value);
  if (officeHourIds.length === 0) return attempt(() => Promise.reject(new Error('Tick at least one taken slot')));
  if (await attempt(() => api('POST', '/student/waitlist', { officeHourIds }), 'Joined the waitlist')) {
    await reloadAll();
  }
}

// ---- bookings and waitlist ----

async function loadBookings() {
  const bookings = await api('GET', '/student/bookings');
  const now = new Date();
  replace(document.getElementById('bookings'), bookings.length === 0
    ? emptyRow('No bookings yet.')
    : el('table', {}, bookings.map((b) => {
        const upcoming = new Date(b.startsAt) > now;
        let status = upcoming ? badge('Upcoming', 'ok') : badge('Past');
        if (b.cancelled) status = badge('Cancelled by the professor', 'bad');
        return el('tr', {}, el('td', {}, el('strong', {}, b.courseCode)), el('td', {}, formatRange(b.startsAt, b.endsAt)),
          el('td', {}, b.location), el('td', {}, status),
          el('td', { class: 'actions' }, upcoming && !b.cancelled
            ? el('button', { class: 'danger', onclick: () => cancelBooking(b) }, 'Cancel') : null));
      })));
}

async function loadWaitlist() {
  const entries = await api('GET', '/student/waitlist');
  replace(document.getElementById('waitlist'), entries.length === 0
    ? emptyRow('You are not waiting for any office hour.')
    : entries.map((e) => el('div', {},
        el('h3', {}, `${e.courseCode} · ${formatDay(e.sessionDate)}`,
          e.offerPending ? ' · ' : '', e.offerPending ? badge('Offer waiting: check your email', 'warn') : null),
        el('table', {}, e.officeHours.map((s) => el('tr', {},
          el('td', {}, formatRange(s.startsAt, s.endsAt)), el('td', {}, s.location)))),
        el('div', { class: 'row' }, el('button', { class: 'danger', onclick: () => leave(e) }, 'Leave this waitlist')))));
}

async function leave(entry) {
  if (!confirm('Leave this waitlist? Joining again puts you at the back.')) return;
  if (await attempt(() => api('DELETE', `/student/waitlist/${entry.id}`), 'Left the waitlist')) await reloadAll();
}

await reloadAll();
// Offers and bookings can change without this page doing anything (another student
// cancels, a round is decided): refresh the lists every 15 seconds.
// Skipped while waitlist boxes are ticked, so a refresh never clears a selection.
setInterval(() => {
  if (document.querySelector('#slots input:checked')) return;
  reloadAll().catch(() => {});
}, 15000);
