/**
 * Wall-clock formatting for the console, in the process's local time zone
 * (the system zone, or `TZ` when set). Machine output such as JSON logs and
 * history records keeps ISO-8601 UTC instead.
 */

/** `14:03:22` */
export function formatClock(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
}

/** `2026-09-29` */
export function formatDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2026-09-29 14:03:22 UTC+02:00 (Europe/Paris)` */
export function formatTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatDay(date)} ${formatClock(date)} UTC${sign}${hours}:${minutes}${zone ? ` (${zone})` : ''}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
