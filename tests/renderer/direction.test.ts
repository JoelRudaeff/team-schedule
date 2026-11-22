/**
 * Hebrew and English in one sentence: sentences of the interface keep the interface's
 * direction, whatever a name, a time or a value inside them looks like. Plus the wording of
 * counts, and the two small rules for input boxes.
 *
 * (Found by an independent review: a room called "Room A" turned Hebrew sentences around,
 * ranges read end–start, the "old → new" arrow pointed the wrong way, and one change read
 * "1 changes".)
 */
import { describe, expect, it } from 'vitest';
import type { DiffItem } from '@shared/merge';
import type { ScheduleConfig, ScheduleEvent } from '@shared/types';
import { isolate, ltr, translate, translatePlural, translatorFor, withoutIsolates } from '@renderer/i18n';
import { en } from '@renderer/i18n/en';
import { he } from '@renderer/i18n/he';
import { readableCommitSubject } from '@renderer/lib/commitText';
import { describeDiff, eventLine } from '@renderer/lib/describe';
import { parseWholeNumber, textDirection } from '@renderer/lib/inputs';

const LRI = String.fromCharCode(0x2066);
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

const CONFIG: ScheduleConfig = {
  course: { name: 'DevOps', startDate: null, endDate: null },
  timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
  subjects: [],
  locations: [{ id: 'l1', name: 'Room A' }],
  teachers: [],
  classes: [],
};

const EVENT: ScheduleEvent = { id: 'e', day: 2, start: 780, end: 840, title: 'Lab', subjectId: null, locationId: 'l1', teacherIds: [], classIds: [], notes: '' };

describe('placeholders', () => {
  it('a text that is filled in is isolated, so it cannot re-order the sentence around it', () => {
    const text = translate('he', 'grid.clashLocation', { name: 'Room A', other: 'Overlap 2' });
    expect(text).toContain(`${FSI}Room A${PDI}`);
    expect(text).toContain(`${FSI}Overlap 2${PDI}`);
    // The sentence itself starts with what the table starts with — not with the name's direction mark alone.
    expect(withoutIsolates(text)).toBe(withoutIsolates(translate('he', 'grid.clashLocation', { name: 'Room A', other: 'Overlap 2' })));
    expect(withoutIsolates(text)).toContain('Room A');
  });

  it('a number is put in as it is', () => {
    expect(translate('en', 'toolbar.weekOfCourse', { number: 4 })).toBe('Week 4');
    expect(translatePlural('en', 'store.exportIcsDone', 3)).toBe('3 events exported.');
  });

  it('a placeholder without a value stays visible, and an inherited name is no value', () => {
    expect(translate('en', 'toolbar.weekOfCourse', {})).toBe('Week {number}');
    expect(translate('en', 'settings.removeTitle', { toString: 'x' } as never)).toBe('Remove "{name}"?');
  });

  it('isolate / ltr / withoutIsolates', () => {
    expect(isolate('abc')).toBe(`${FSI}abc${PDI}`);
    expect(ltr('09:00–10:30')).toBe(`${LRI}09:00–10:30${PDI}`);
    expect(withoutIsolates(`x${isolate('a')}y${ltr('b')}z`)).toBe('xaybz');
  });
});

describe('ranges and arrows', () => {
  it('the hours of an event read left to right inside any line, and the room keeps its own direction', () => {
    for (const lang of ['en', 'he'] as const) {
      const line = eventLine(EVENT, '2026-11-22', CONFIG, translatorFor(lang));
      expect(line).toContain(`${LRI}13:00–14:00${PDI}`);
      expect(line).toContain(`${FSI}Room A${PDI}`);
    }
  });

  it('"no such week": the range is marked left to right in both tables', () => {
    for (const lang of ['en', 'he'] as const) {
      expect(translate(lang, 'toolbar.weekNumberInvalid', { number: '99', max: 13 })).toContain(`(${LRI}1–13${PDI})`);
    }
  });

  it('"old → new": the arrow follows the reading direction, and each value is isolated', () => {
    const item: DiffItem = { key: 'course.name', kind: 'course', field: 'name', change: 'modified', before: 'Course A', after: 'קורס ב׳', changedFields: [] };
    const english = describeDiff(item, CONFIG, translatorFor('en')).detail;
    const hebrew = describeDiff(item, CONFIG, translatorFor('he')).detail;
    expect(english).toBe(`${FSI}Course A${PDI} → ${FSI}קורס ב׳${PDI}`);
    // In Hebrew the old value stands on the right, so the arrow has to point left.
    expect(hebrew).toBe(`${FSI}Course A${PDI} ← ${FSI}קורס ב׳${PDI}`);
  });
});

describe('counts', () => {
  it('Hebrew has its own words for exactly two where the table gives them', () => {
    expect(translatePlural('he', 'time.hoursAgo', 1)).toBe('לפני שעה');
    expect(translatePlural('he', 'time.hoursAgo', 2)).toBe('לפני שעתיים');
    expect(translatePlural('he', 'time.hoursAgo', 3)).toBe('לפני 3 שעות');
    expect(translatePlural('he', 'time.daysAgo', 2)).toBe('שלשום');
    // A text without a form for two uses the general one.
    expect(translatePlural('he', 'store.exportIcsDone', 2)).toBe('2 אירועים יוצאו.');
    expect(translatePlural('en', 'store.exportIcsDone', 2)).toBe('2 events exported.');
  });

  it('the status "update available and N unpublished" and the commit summary read right for one', () => {
    expect(translatePlural('he', 'toolbar.statusBoth', 1)).toBe('יש עדכון · שינוי אחד טרם פורסם');
    expect(translatePlural('he', 'toolbar.statusBoth', 4)).toBe('יש עדכון · 4 שינויים טרם פורסמו');
    expect(translatePlural('en', 'toolbar.statusBoth', 1)).toBe('Update available · 1 unpublished');
    expect(readableCommitSubject('Update schedule: events +1 ~2 -1', translatorFor('he'))).toBe('אירועים: אחד נוסף, 2 שונו, אחד הוסר');
    expect(readableCommitSubject('Update schedule: events +1 ~2 -1', translatorFor('en'))).toBe('Events: 1 added, 2 changed, 1 removed');
  });

  it('every text that is counted has both forms in both languages, and "two" only together with them', () => {
    for (const table of [en, he] as Record<string, Record<string, string>>[]) {
      for (const [namespace, texts] of Object.entries(table)) {
        for (const key of Object.keys(texts)) {
          const base = key.replace(/_(one|two|other)$/, '');
          if (base === key) continue;
          expect(Object.hasOwn(texts, `${base}_one`), `${namespace}.${base}_one`).toBe(true);
          expect(Object.hasOwn(texts, `${base}_other`), `${namespace}.${base}_other`).toBe(true);
        }
      }
    }
  });

  it('no Hebrew text that takes {count} outside a counted form reads "1 <plural>"', () => {
    const texts = he as Record<string, Record<string, string>>;
    const offenders: string[] = [];
    for (const [namespace, table] of Object.entries(texts)) {
      for (const [key, text] of Object.entries(table)) {
        if (text.includes('{count}') && !/_(one|two|other)$/.test(key)) offenders.push(`${namespace}.${key}`);
      }
    }
    // The few that remain are never used with 1 (seconds between checks, minutes of a row),
    // are abbreviations ("30 דק׳"), or read the same for every number ("… and 3 more").
    expect(offenders.sort()).toEqual(['settings.pollSeconds', 'settings.slotMinutes', 'sync.minutes', 'transfer.importMore'].sort());
  });
});

describe('input boxes', () => {
  it('an empty box follows the interface, a filled one its own text', () => {
    expect(textDirection('')).toBeUndefined();
    expect(textDirection('a')).toBe('auto');
    expect(textDirection('ש')).toBe('auto');
    expect(textDirection(' ')).toBe('auto');
  });

  it('a whole number is digits only: no "1e1", no "1.5", nothing outside the range', () => {
    expect(parseWholeNumber('12')).toBe(12);
    expect(parseWholeNumber(' 12 ')).toBe(12);
    expect(parseWholeNumber('0')).toBe(0);
    expect(parseWholeNumber('-3')).toBe(-3);
    expect(parseWholeNumber('007')).toBe(7);
    for (const text of ['', ' ', '1e1', '1.5', '1,5', 'abc', '12abc', '+5', '--5', '0x10', '१२', '9'.repeat(30)]) {
      expect(parseWholeNumber(text), JSON.stringify(text)).toBeNull();
    }
    expect(parseWholeNumber('200', 1, 104)).toBeNull();
    expect(parseWholeNumber('104', 1, 104)).toBe(104);
    expect(parseWholeNumber('0', 1)).toBeNull();
    expect(parseWholeNumber('1', 1)).toBe(1);
  });
});
