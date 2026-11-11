import { api, requireUser, logout } from './api.js';
import { el, replace, attempt, badge, emptyRow } from './ui.js';
import { formatRange, torontoToUtcIso, torontoToday, formatDateTime } from './time.js';

const user = await requireUser('PROFESSOR');
document.getElementById('who').textContent = `· ${user.name}`;
document.getElementById('logout').addEventListener('click', logout);
document.querySelector('#new-slot input[name=date]').min = torontoToday();
document.getElementById('filter-course').addEventListener('change', loadSlots);
document.getElementById('show-past').addEventListener('change', loadSlots);

const openWaitlists = new Set(); // slots whose waitlist is expanded

// ---- courses ----

async function loadCourses() {
  const courses = await api('GET', '/professor/courses');
  replace(document.getElementById('courses'), courses.length === 0
    ? emptyRow('No courses yet. Create one below.')
    : el('table', {}, el('tr', {}, el('th', {}, 'Code'), el('th', {}, 'Name'), el('th', {}, 'Students')),
        courses.map((c) => el('tr', {}, el('td', {}, el('strong', {}, c.code)), el('td', {}, c.name),
          el('td', {}, String(c.enrolledCount))))));

  for (const id of ['slot-course', 'filter-course']) {
    const select = document.getElementById(id);
    const selected = select.value;
    const first = id === 'filter-course' ? [el('option', { value: '' }, 'All courses')] : [];
    replace(select, first, courses.map((c) => el('option', { value: c.id, selected: c.id === selected }, c.code)));
  }
}

document.getElementById('new-course').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = { code: form.get('code'), name: form.get('name') };
  if (await attempt(() => api('POST', '/professor/courses', body), `Course ${body.code} created`)) {
    event.target.reset();
    await loadCourses();
  }
});

// ---- office hours ----

document.getElementById('new-slot').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = {
    courseId: form.get('courseId'),
    startsAt: torontoToUtcIso(form.get('date'), form.get('start')),
    endsAt: torontoToUtcIso(form.get('date'), form.get('end')),
    location: form.get('location'),
  };
  if (await attempt(() => api('POST', '/professor/office-hours', body), 'Office hour added')) {
    await loadSlots();
  }
});

async function loadSlots() {
  const courseId = document.getElementById('filter-course').value;
  const showPast = document.getElementById('show-past').checked;
  const params = new URLSearchParams();
  if (courseId) params.set('courseId', courseId);
  if (!showPast) params.set('from', new Date().toISOString());
  let slots = await api('GET', `/professor/office-hours?${params}`);
  if (!showPast) slots = slots.filter((s) => !s.cancelled);

  const container = document.getElementById('slots');
  if (slots.length === 0) return replace(container, emptyRow('No office hours to show.'));
  const rows = [];
  for (const s of slots) {
    let state;
    if (s.cancelled) state = badge('Cancelled', 'bad');
    else if (s.bookedBy) state = badge(`Booked: ${s.bookedBy.name}`, 'ok');
    else if (s.offerRoundOpen) state = badge('Offered to the waitlist', 'warn');
    else state = badge('Free');
    const upcoming = new Date(s.startsAt) > new Date();
    rows.push(el('tr', {},
      el('td', {}, el('strong', {}, s.courseCode)),
      el('td', {}, formatRange(s.startsAt, s.endsAt)),
      el('td', {}, s.location),
      el('td', {}, state),
      el('td', {}, s.waitlisted > 0
        ? el('button', { class: 'secondary', onclick: () => toggleWaitlist(s.id) }, `${s.waitlisted} waiting`)
        : el('span', { class: 'muted' }, 'no waitlist')),
      el('td', { class: 'actions' }, !s.cancelled && upcoming
        ? el('button', { class: 'danger', onclick: () => cancelSlot(s) }, 'Cancel') : null)));
    if (openWaitlists.has(s.id)) rows.push(await waitlistRow(s.id));
  }
  replace(container, el('table', {}, rows));
}

async function waitlistRow(slotId) {
  const detail = await api('GET', `/professor/office-hours/${slotId}`);
  return el('tr', {}, el('td', { colspan: 6 },
    el('ol', {}, detail.waitlist.map((w) => el('li', {}, `${w.name}, waiting since ${formatDateTime(w.joinedAt)}`)))));
}

async function toggleWaitlist(slotId) {
  if (openWaitlists.has(slotId)) openWaitlists.delete(slotId);
  else openWaitlists.add(slotId);
  await loadSlots();
}

async function cancelSlot(slot) {
  const who = slot.bookedBy ? ` ${slot.bookedBy.name} will be emailed.` : '';
  if (!confirm(`Cancel this office hour?${who} It is not offered to the waitlist.`)) return;
  if (await attempt(() => api('DELETE', `/professor/office-hours/${slot.id}`), 'Office hour cancelled')) {
    await loadSlots();
  }
}

await loadCourses();
await loadSlots();
setInterval(() => loadSlots().catch(() => {}), 15000); // bookings change without this page
