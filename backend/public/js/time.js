// Times are stored and sent in UTC; people see and type Toronto time, whatever the
// time zone of their own computer.

const TZ = 'America/Toronto';

const dateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

export function formatDateTime(iso) {
  return dateTimeFmt.format(new Date(iso));
}

export function formatTime(iso) {
  return timeFmt.format(new Date(iso));
}

// 'YYYY-MM-DD' (a Toronto calendar day, e.g. sessionDate) → "Thursday, November 12, 2026".
// Formatted as UTC noon so no time zone can move it to another day.
export function formatDay(day) {
  return dayFmt.format(new Date(`${day}T12:00:00Z`));
}

export function formatRange(startsAt, endsAt) {
  return `${formatDateTime(startsAt)} to ${formatTime(endsAt)}`;
}

// Minutes Toronto is ahead of UTC at instant `ts` (negative: -300 in winter, -240 in summer).
function torontoOffsetMinutes(ts) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - ts) / 60000);
}

// Toronto wall-clock date 'YYYY-MM-DD' + time 'HH:MM' → UTC ISO string.
// Two passes so a date on the other side of a daylight-saving change gets the right offset.
export function torontoToUtcIso(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  let ts = wallAsUtc;
  for (let i = 0; i < 2; i++) ts = wallAsUtc - torontoOffsetMinutes(ts) * 60000;
  return new Date(ts).toISOString();
}

// Today's date in Toronto as 'YYYY-MM-DD' (for the date picker's minimum).
export function torontoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
