// Opened from the offer email: /offer.html#<token>. Showing the offer never changes
// anything (GET); only pressing a button sends the answer (POST). Email scanners that
// open links by themselves therefore cannot accept or decline for the student.

import { el, replace } from './ui.js';
import { formatRange, formatDateTime } from './time.js';

const token = window.location.hash.slice(1);
const box = document.getElementById('offer');

const MESSAGES = {
  PENDING: null,
  WAITING: 'You said yes. A higher-ranked student has not answered yet; you will get an email if the slot is yours.',
  BOOKED: 'The office hour is yours. It is in your bookings.',
  DECLINED: 'You said no. You stay on the waitlist for your other slots.',
  EXPIRED: 'This offer expired.',
  CANCELLED: 'This offer is no longer available (the slot went to someone else, was cancelled, or you left the waitlist).',
  NOT_AWARDED: 'You said yes, but the slot could not be given to you.',
};

async function show() {
  if (!token) return replace(box, el('p', {}, 'This link is incomplete.'));
  const res = await fetch(`/offers/${encodeURIComponent(token)}`);
  if (!res.ok) return replace(box, el('p', {}, 'This offer was not found.'));
  const offer = await res.json();
  const { courseCode, startsAt, endsAt, location } = offer.officeHour;

  const details = [
    el('h2', {}, courseCode),
    el('p', { class: 'big' }, formatRange(startsAt, endsAt), el('br'), location),
  ];
  if (offer.status !== 'PENDING') {
    return replace(box, details, el('p', {}, MESSAGES[offer.status]), el('a', { href: '/' }, 'Go to the app'));
  }
  replace(box, details,
    el('p', {}, `Answer before ${formatDateTime(offer.expiresAt)} (Toronto time). Do you want this office hour?`),
    el('div', { class: 'row' },
      el('button', { onclick: () => answer(true) }, 'Yes, I want it'),
      el('button', { class: 'danger', onclick: () => answer(false) }, 'No, thanks')));
}

async function answer(interested) {
  for (const b of box.querySelectorAll('button')) b.disabled = true;
  const res = await fetch(`/offers/${encodeURIComponent(token)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interested }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    replace(box, el('p', { class: 'big' }, MESSAGES[data.status]), el('a', { href: '/' }, 'Go to the app'));
  } else {
    replace(box, el('p', {}, data.error || 'Something went wrong.'), el('a', { href: '/' }, 'Go to the app'));
  }
}

show();
