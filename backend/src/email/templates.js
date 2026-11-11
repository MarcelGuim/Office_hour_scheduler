// Email texts. Times are shown in Toronto time (stored in UTC).

import { getConfig } from '../config.js';

const torontoFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function toronto(date) {
  return torontoFormat.format(new Date(date));
}

function slotLine(slot) {
  return `${slot.courseCode}, ${toronto(slot.startsAt)} to ${toronto(slot.endsAt)}, at ${slot.location}`;
}

export function offerEmail({ to, name, slot, token, expiresAt }) {
  const link = `${getConfig().publicBaseUrl}/offer.html#${token}`;
  return {
    to,
    subject: `Office hour available: ${slot.courseCode}`,
    body: [
      `Hi ${name},`,
      '',
      `An office hour you are waiting for is free:`,
      `  ${slotLine(slot)}`,
      '',
      `Open this link to answer yes or no before ${toronto(expiresAt)}:`,
      `  ${link}`,
      '',
      'Up to three students are asked at once; the slot goes to the highest-ranked yes.',
    ].join('\n'),
  };
}

export function awardedEmail({ to, name, slot }) {
  return {
    to,
    subject: `You got the office hour: ${slot.courseCode}`,
    body: [`Hi ${name},`, '', 'The office hour is now booked for you:', `  ${slotLine(slot)}`].join('\n'),
  };
}

export function professorCancelledEmail({ to, name, slot }) {
  return {
    to,
    subject: `Office hour cancelled: ${slot.courseCode}`,
    body: [`Hi ${name},`, '', 'The professor cancelled your office hour:', `  ${slotLine(slot)}`].join('\n'),
  };
}
