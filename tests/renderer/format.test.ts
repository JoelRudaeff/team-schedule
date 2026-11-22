/** Locale-aware formatting of dates and times. */
import { describe, expect, it } from 'vitest';
import type { DayIndex, Lang } from '@shared/types';
import {
  dayName,
  formatClock,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatDayMonthNumeric,
  formatDuration,
  formatFullDate,
  formatRelative,
  formatTime,
  formatTimeRange,
  formatWeekRange,
  localeOf,
} from '@renderer/lib/format';

const DAYS: DayIndex[] = [0, 1, 2, 3, 4, 5, 6];
const HEBREW = /[֐-׿]/;
const LATIN = /[A-Za-z]/;

/** ICU versions differ in the (thin) spaces around the range dash and in invisible direction marks. */
function tidy(text: string): string {
  return text
    .replace(/[‎‏؜]/g, '')
    .replace(/\s*[–-]\s*/g, '–')
    .replace(/\s+/g, ' ');
}

describe('localeOf', () => {
  it('maps the two UI languages', () => {
    expect(localeOf('en')).toBe('en-GB');
    expect(localeOf('he')).toBe('he-IL');
  });
});

describe('formatTime / formatTimeRange', () => {
  it('formatTime is 24-hour with two digits', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(570)).toBe('09:30');
    expect(formatTime(785)).toBe('13:05');
    expect(formatTime(1440)).toBe('24:00');
  });

  it('formatTimeRange joins with an en dash and no spaces', () => {
    expect(formatTimeRange(540, 630)).toBe('09:00–10:30');
    expect(formatTimeRange(570, 645)).toBe('09:30–10:45');
    expect(formatTimeRange(0, 1440)).toBe('00:00–24:00');
    expect(formatTimeRange(1425, 1440)).toBe('23:45–24:00');
    expect(formatTimeRange(481, 533)).toBe('08:01–08:53');
    expect(formatTimeRange(540, 630)).toContain('–');
    expect(formatTimeRange(540, 630)).not.toMatch(/\s/);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [1, '0:01'],
    [15, '0:15'],
    [45, '0:45'],
    [59, '0:59'],
    [60, '1:00'],
    [90, '1:30'],
    [605, '10:05'],
    [1440, '24:00'],
    [1500, '25:00'],
  ])('%i minutes -> %s', (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text);
  });

  it('rounds fractions and never goes negative', () => {
    expect(formatDuration(89.6)).toBe('1:30');
    expect(formatDuration(59.5)).toBe('1:00');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(-0.2)).toBe('0:00');
  });
});

describe('dayName', () => {
  it('English, all seven days', () => {
    expect(DAYS.map((d) => dayName(d, 'en'))).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
    expect(DAYS.map((d) => dayName(d, 'en', 'long'))).toEqual(DAYS.map((d) => dayName(d, 'en')));
    expect(DAYS.map((d) => dayName(d, 'en', 'short'))).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(DAYS.map((d) => dayName(d, 'en', 'narrow'))).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  });

  it('Hebrew, all seven days', () => {
    expect(DAYS.map((d) => dayName(d, 'he'))).toEqual([
      'יום ראשון',
      'יום שני',
      'יום שלישי',
      'יום רביעי',
      'יום חמישי',
      'יום שישי',
      'יום שבת',
    ]);
    const short = DAYS.map((d) => dayName(d, 'he', 'short'));
    const narrow = DAYS.map((d) => dayName(d, 'he', 'narrow'));
    expect(short[0]).toBe('יום א׳');
    expect(narrow[0]).toBe('א׳');
    expect(short[6]).toContain('שבת');
    for (const names of [short, narrow]) {
      expect(new Set(names).size).toBe(7);
      for (const name of names) {
        expect(name).toMatch(HEBREW);
        expect(name).not.toMatch(LATIN);
      }
    }
    // Sunday … Friday carry the letters א … ו in order
    expect(narrow.slice(0, 6).map((name) => name[0])).toEqual(['א', 'ב', 'ג', 'ד', 'ה', 'ו']);
  });

  it('agrees with the weekday of real dates', () => {
    // 22 Nov 2026 is a Sunday
    expect(formatFullDate('2026-11-22', 'en')).toContain(dayName(0, 'en'));
    expect(formatFullDate('2026-11-28', 'en')).toContain(dayName(6, 'en'));
    expect(formatFullDate('2026-11-25', 'he')).toContain(dayName(3, 'he'));
  });
});

describe('single dates', () => {
  it('formatDayMonth', () => {
    expect(formatDayMonth('2026-11-22', 'en')).toBe('22 Nov');
    expect(formatDayMonth('2026-01-05', 'en')).toBe('5 Jan');
    expect(formatDayMonth('2024-02-29', 'en')).toBe('29 Feb');
    const hebrew = formatDayMonth('2026-11-22', 'he');
    expect(hebrew).toContain('22');
    expect(hebrew).toMatch(HEBREW);
    expect(hebrew).not.toMatch(LATIN);
  });

  it('formatDayMonthNumeric is day/month without leading zeros', () => {
    expect(formatDayMonthNumeric('2026-11-22')).toBe('22/11');
    expect(formatDayMonthNumeric('2026-01-05')).toBe('5/1');
    expect(formatDayMonthNumeric('2026-10-09')).toBe('9/10');
    expect(formatDayMonthNumeric('2026-12-31')).toBe('31/12');
  });

  it('formatDate', () => {
    expect(formatDate('2026-11-22', 'en')).toBe('22 Nov 2026');
    expect(formatDate('2027-01-01', 'en')).toBe('1 Jan 2027');
    expect(formatDate('2024-02-29', 'en')).toBe('29 Feb 2024');
    const hebrew = formatDate('2026-11-22', 'he');
    expect(hebrew).toMatch(/22.*2026/);
    expect(hebrew).toMatch(HEBREW);
    expect(hebrew).not.toMatch(LATIN);
  });

  it('formatDate keeps the calendar day on the days the clocks change', () => {
    for (const date of ['2026-03-27', '2026-03-29', '2026-10-25', '2026-11-01']) {
      expect(formatDate(date, 'en').startsWith(`${Number(date.slice(8))} `)).toBe(true);
    }
  });

  it('formatFullDate', () => {
    expect(tidy(formatFullDate('2026-11-22', 'en')).replace(',', '')).toBe('Sunday 22 November 2026');
    const hebrew = formatFullDate('2026-11-22', 'he');
    expect(hebrew).toContain('יום ראשון');
    expect(hebrew).toMatch(/22.*2026/);
    expect(hebrew).not.toMatch(LATIN);
  });

  it('formatDateTime and formatClock use the 24-hour clock of this computer', () => {
    const afternoon = new Date(2026, 10, 21, 14, 5).getTime();
    const justAfterMidnight = new Date(2026, 10, 21, 0, 7).getTime();
    expect(formatClock(afternoon, 'en')).toBe('14:05');
    expect(formatClock(afternoon, 'he')).toBe('14:05');
    expect(formatClock(justAfterMidnight, 'en')).toBe('00:07');
    expect(formatClock(justAfterMidnight, 'he')).toBe('00:07');
    expect(formatDateTime(afternoon, 'en')).toMatch(/^21 Nov 2026,? (at )?14:05$/);
    expect(formatDateTime(justAfterMidnight, 'en')).toMatch(/^21 Nov 2026,? (at )?00:07$/);
    const hebrew = formatDateTime(afternoon, 'he');
    expect(hebrew).toMatch(/21.*2026.*14:05/);
    expect(hebrew).not.toMatch(/AM|PM/i);
  });
});

describe('formatWeekRange', () => {
  it('inside one month', () => {
    expect(tidy(formatWeekRange('2026-11-22', 'en'))).toBe('22–28 Nov 2026');
    expect(tidy(formatWeekRange('2026-11-01', 'en'))).toBe('1–7 Nov 2026');
  });

  it('across two months', () => {
    expect(tidy(formatWeekRange('2026-11-29', 'en'))).toBe('29 Nov–5 Dec 2026');
    expect(tidy(formatWeekRange('2024-02-25', 'en'))).toBe('25 Feb–2 Mar 2024');
  });

  it('across two years', () => {
    expect(tidy(formatWeekRange('2026-12-27', 'en'))).toBe('27 Dec 2026–2 Jan 2027');
  });

  it('Hebrew: same numbers, Hebrew months, the year only as often as needed', () => {
    const count = (text: string, part: string): number => text.split(part).length - 1;

    const inside = tidy(formatWeekRange('2026-11-22', 'he'));
    expect(inside).toMatch(/22.*28.*2026/);
    expect(count(inside, '2026')).toBe(1);

    const months = tidy(formatWeekRange('2026-11-29', 'he'));
    expect(months).toMatch(/29.*5.*2026/);
    expect(count(months, '2026')).toBe(1);

    const years = tidy(formatWeekRange('2026-12-27', 'he'));
    expect(years).toMatch(/27.*2026.*2.*2027/);

    for (const text of [inside, months, years]) {
      expect(text).toMatch(HEBREW);
      expect(text).not.toMatch(LATIN);
    }
  });

  it('always shows first and last day of the week, for a whole year of weeks', () => {
    const langs: Lang[] = ['en', 'he'];
    let start = new Date(Date.UTC(2026, 0, 4));
    for (let i = 0; i < 53; i++) {
      const iso = start.toISOString().slice(0, 10);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      for (const lang of langs) {
        const text = tidy(formatWeekRange(iso, lang));
        const numbers = text.match(/\d+/g) ?? [];
        expect(numbers[0], `${lang} ${iso}: ${text}`).toBe(String(start.getUTCDate()));
        expect(numbers, `${lang} ${iso}: ${text}`).toContain(String(end.getUTCDate()));
        expect(numbers.at(-1), `${lang} ${iso}: ${text}`).toBe(String(end.getUTCFullYear()));
      }
      start = new Date(start.getTime() + 7 * 86_400_000);
    }
  });
});

describe('formatRelative', () => {
  const NOW = new Date(2026, 10, 22, 12, 0, 0).getTime();
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const ago = (ms: number, lang: Lang): string => formatRelative(NOW - ms, lang, NOW);
  const ahead = (ms: number, lang: Lang): string => formatRelative(NOW + ms, lang, NOW);
  const rtf = (lang: Lang): Intl.RelativeTimeFormat => new Intl.RelativeTimeFormat(localeOf(lang), { numeric: 'auto' });

  it('seconds: "now"', () => {
    expect(ago(0, 'en')).toBe('now');
    expect(ago(10 * SEC, 'en')).toBe('now');
    expect(ago(44 * SEC, 'en')).toBe('now');
    expect(ahead(30 * SEC, 'en')).toBe('now');
    expect(ago(10 * SEC, 'he')).toBe('עכשיו');
    expect(ahead(30 * SEC, 'he')).toBe('עכשיו');
  });

  it('minutes', () => {
    expect(ago(45 * SEC, 'en')).toBe('1 minute ago');
    expect(ago(MIN, 'en')).toBe('1 minute ago');
    expect(ago(3 * MIN, 'en')).toBe('3 minutes ago');
    expect(ago(3 * MIN + 20 * SEC, 'en')).toBe('3 minutes ago');
    expect(ago(30 * MIN, 'en')).toBe('30 minutes ago');
    expect(ahead(3 * MIN, 'en')).toBe('in 3 minutes');
    expect(ago(3 * MIN, 'he')).toBe('לפני 3 דקות');
    expect(ago(3 * MIN, 'he')).toBe(rtf('he').format(-3, 'minute'));
    expect(ahead(3 * MIN, 'he')).toBe(rtf('he').format(3, 'minute'));
  });

  it('hours', () => {
    expect(ago(HOUR, 'en')).toBe('1 hour ago');
    expect(ago(2 * HOUR, 'en')).toBe('2 hours ago');
    expect(ago(5 * HOUR + 20 * MIN, 'en')).toBe('5 hours ago');
    expect(ahead(2 * HOUR, 'en')).toBe('in 2 hours');
    expect(ago(5 * HOUR, 'he')).toBe(rtf('he').format(-5, 'hour'));
    expect(ago(5 * HOUR, 'he')).toContain('שעות');
  });

  it('days', () => {
    expect(ago(DAY, 'en')).toBe('yesterday');
    expect(ahead(DAY, 'en')).toBe('tomorrow');
    expect(ago(5 * DAY, 'en')).toBe('5 days ago');
    expect(ago(29 * DAY, 'en')).toBe('29 days ago');
    expect(ahead(5 * DAY, 'en')).toBe('in 5 days');
    expect(ago(DAY, 'he')).toBe('אתמול');
    expect(ahead(DAY, 'he')).toBe('מחר');
    expect(ago(5 * DAY, 'he')).toBe('לפני 5 ימים');
  });

  it('months', () => {
    expect(ago(30 * DAY, 'en')).toBe('last month');
    expect(ago(60 * DAY, 'en')).toBe('2 months ago');
    expect(ago(200 * DAY, 'en')).toBe('7 months ago');
    expect(ahead(90 * DAY, 'en')).toBe('in 3 months');
    expect(ago(30 * DAY, 'he')).toBe(rtf('he').format(-1, 'month'));
    expect(ago(150 * DAY, 'he')).toBe(rtf('he').format(-5, 'month'));
    expect(ago(150 * DAY, 'he')).toContain('חודשים');
  });

  it('years', () => {
    expect(ago(365 * DAY, 'en')).toBe('last year');
    expect(ago(3 * 365 * DAY, 'en')).toBe('3 years ago');
    expect(ahead(2 * 365 * DAY, 'en')).toBe('in 2 years');
    expect(ago(365 * DAY, 'he')).toBe(rtf('he').format(-1, 'year'));
    expect(ago(3 * 365 * DAY, 'he')).toBe('לפני 3 שנים');
  });

  it('uses the current time when no "now" is given', () => {
    expect(formatRelative(Date.now(), 'en')).toBe('now');
    expect(formatRelative(Date.now() - 5 * MIN, 'en')).toBe('5 minutes ago');
    expect(formatRelative(Date.now(), 'he')).toBe('עכשיו');
  });

  it('never shows a count that belongs to the next larger unit ("60 minutes", "24 hours")', () => {
    for (const lang of ['en', 'he'] as const) {
      const texts = [
        ago(59 * MIN + 40 * SEC, lang),
        ago(23 * HOUR + 40 * MIN, lang),
        ahead(59 * MIN + 40 * SEC, lang),
        ahead(23 * HOUR + 40 * MIN, lang),
      ];
      expect(texts[0]).not.toContain('60');
      expect(texts[1]).not.toContain('24');
      expect(texts[2]).not.toContain('60');
      expect(texts[3]).not.toContain('24');
    }
  });

  it('is symmetric: the past never reads as the future', () => {
    for (const ms of [50 * SEC, 5 * MIN, 5 * HOUR, 5 * DAY, 90 * DAY, 800 * DAY]) {
      expect(ago(ms, 'en')).toMatch(/ago$/);
      expect(ahead(ms, 'en')).toMatch(/^in /);
      expect(ago(ms, 'he')).not.toBe(ahead(ms, 'he'));
    }
  });
});
