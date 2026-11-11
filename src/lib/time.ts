// All dates in this app are Monterrey dates, whatever the device's time zone.
// "Now" comes from the server (Armado CH lesson: phones with a wrong clock or zone).

export const TIME_ZONE = 'America/Monterrey';
const LOCALE = 'es-MX';

const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Formats a 'YYYY-MM-DD' that has been anchored at 12:00 UTC, so the zone can't shift the day.
const dayFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const shortDayFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', day: 'numeric', month: 'short' });

let serverOffsetMs = 0;

/** Record the server's clock. Call with the server timestamp and the local time it was received. */
export function setServerNow(serverIso: string, receivedAtMs: number = Date.now()): void {
  const t = Date.parse(serverIso);
  if (!Number.isNaN(t)) serverOffsetMs = t - receivedAtMs;
}

/** Current time per the server (falls back to the device clock until setServerNow runs). */
export function now(): Date {
  return new Date(Date.now() + serverOffsetMs);
}

/** Monterrey calendar date, 'YYYY-MM-DD'. */
export function localDate(d: Date): string {
  return ymdFmt.format(d);
}

/** Monterrey wall-clock time, 'HH:MM'. */
export function localTime(d: Date): string {
  return hmFmt.format(d);
}

function anchor(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

/** Whole calendar days from a to b ('YYYY-MM-DD'); positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((anchor(b).getTime() - anchor(a).getTime()) / 86_400_000);
}

/** Calendar days between an instant and "now", both in Monterrey. */
export function ageInDays(d: Date, ref: Date = now()): number {
  return daysBetween(localDate(d), localDate(ref));
}

/** 'lun, 3 nov' style label for a 'YYYY-MM-DD'. */
export function formatDay(ymd: string): string {
  return dayFmt.format(anchor(ymd)).replace(/\./g, '').replace(/ de /g, ' ');
}

/** '3 nov' style label for a 'YYYY-MM-DD'. */
export function formatShortDay(ymd: string): string {
  return shortDayFmt.format(anchor(ymd)).replace(/\./g, '').replace(/ de /g, ' ');
}

/** '30 oct, 12:33' in Monterrey time. */
export function formatDateTime(d: Date): string {
  return `${formatShortDay(localDate(d))}, ${localTime(d)}`;
}

/** 'hoy' / 'ayer' / 'hace N días' / 'en N días'. */
export function relativeDays(days: number): string {
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days > 1) return `hace ${days} días`;
  return days === -1 ? 'mañana' : `en ${-days} días`;
}
