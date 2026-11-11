// Local testing only: shows queued emails from GET /dev/mailbox (DEV_MAILBOX=true).

import { el, replace } from './ui.js';
import { formatDateTime } from './time.js';

const container = document.getElementById('mails');

// Turns lines that are links into clickable links; everything else stays text.
function body(text) {
  return el('pre', {}, text.split('\n').flatMap((line) => {
    const url = line.trim();
    const node = /^https?:\/\/\S+$/.test(url) ? el('a', { href: url }, line) : line;
    return [node, '\n'];
  }));
}

async function load() {
  const res = await fetch('/dev/mailbox');
  if (!res.ok) return replace(container, el('p', {}, 'The mailbox is off (DEV_MAILBOX is not true).'));
  const mails = await res.json();
  replace(container, mails.length === 0 ? el('p', { class: 'empty' }, 'No emails yet.') : mails.map((m) =>
    el('section', {},
      el('h2', {}, m.subject),
      el('p', { class: 'muted' }, `To ${m.to} · ${formatDateTime(m.createdAt)} · ${m.sentAt ? 'sent' : 'queued'}`),
      body(m.body))));
}

load();
setInterval(load, 5000);
