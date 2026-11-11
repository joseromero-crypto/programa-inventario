// The device is set to UTC+8 for this whole file: dates must still be Monterrey dates.
declare const process: { env: Record<string, string | undefined> };
process.env.TZ = 'Asia/Singapore';

import { describe, expect, it } from 'vitest';
import { ageInDays, daysBetween, formatDateTime, formatDay, localDate, localTime, now, relativeDays, setServerNow, TIME_ZONE, workdaysBetween } from '../src/lib/time';

describe('time (device in UTC+8)', () => {
  it('runs with the device zone really set to UTC+8', () => {
    expect(new Date('2026-11-10T00:00:00Z').getTimezoneOffset()).toBe(-480);
    expect(TIME_ZONE).toBe('America/Monterrey');
  });

  it('gives the Monterrey date even when the device is already on the next day', () => {
    // 2026-11-10 20:00 in Monterrey = 2026-11-11 10:00 in Singapore
    const d = new Date('2026-11-11T02:00:00Z');
    expect(localDate(d)).toBe('2026-11-10');
    expect(localTime(d)).toBe('20:00');
  });

  it('counts calendar days in Monterrey', () => {
    expect(daysBetween('2026-11-06', '2026-11-10')).toBe(4);
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    // 23:30 Monterrey on Nov 9 vs 00:30 Monterrey on Nov 10: one calendar day
    expect(ageInDays(new Date('2026-11-10T05:30:00Z'), new Date('2026-11-10T06:30:00Z'))).toBe(1);
  });

  it('formats Spanish labels without shifting the day', () => {
    expect(formatDay('2026-11-09')).toBe('lun 9 nov');
    expect(formatDateTime(new Date('2026-10-30T18:33:26Z'))).toBe('30 oct, 12:33');
  });

  it('takes "now" from the server clock', () => {
    const local = Date.now();
    setServerNow(new Date(local + 3 * 3600_000).toISOString(), local); // device 3 h behind
    expect(Math.round((now().getTime() - Date.now()) / 3600_000)).toBe(3);
    setServerNow(new Date().toISOString());
  });

  it('describes ages in Spanish', () => {
    expect([0, 1, 5].map(relativeDays)).toEqual(['hoy', 'ayer', 'hace 5 días']);
  });
});

describe('workdaysBetween (Mon–Fri only)', () => {
  // 2026-11-06 Fri, 07 Sat, 08 Sun, 09 Mon, 10 Tue, 11 Wed
  it('ignores weekends', () => {
    expect(workdaysBetween('2026-11-06', '2026-11-09')).toBe(1); // Fri → Mon
    expect(workdaysBetween('2026-11-06', '2026-11-10')).toBe(2); // Fri → Tue: still fresh at limit 2
    expect(workdaysBetween('2026-11-06', '2026-11-11')).toBe(3); // Fri → Wed: stale
    expect(workdaysBetween('2026-11-07', '2026-11-08')).toBe(0); // Sat → Sun
    expect(workdaysBetween('2026-11-10', '2026-11-10')).toBe(0);
  });
});
