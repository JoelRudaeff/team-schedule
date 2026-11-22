/** Words for merge / diff items and for double bookings, in both languages. */
import { describe, expect, it } from 'vitest';
import type { DiffItem, ItemRef, ItemValue } from '@shared/merge';
import type { Clash } from '@shared/model';
import type { Lang, ScheduleConfig, ScheduleEvent } from '@shared/types';
import { translatorFor as realTranslatorFor, withoutIsolates, type Translator } from '@renderer/i18n';
import { describeClashes as describeClashesRaw } from '@renderer/lib/clashText';
import {
  describeDiff as describeDiffRaw,
  describeItem as describeItemRaw,
  eventLine as eventLineRaw,
  fieldList,
  isEvent,
  isNamed,
  lookupConfig,
  scalarText,
} from '@renderer/lib/describe';
import { dayName, formatDate, formatDayMonth, formatWeekRange } from '@renderer/lib/format';

const W = '2026-11-22';

// The texts carry invisible direction marks around names, hours and values (they have tests of
// their own at the end of this file). The tests about WORDING compare the text without them.
function translatorFor(lang: Lang): Translator {
  const real = realTranslatorFor(lang);
  return {
    ...real,
    t: (key, params) => withoutIsolates(real.t(key, params)),
    tn: (key, count, params) => withoutIsolates(real.tn(key, count, params)),
  };
}
const plain = <T extends { title: string; detail: string }>(text: T): T => ({
  ...text,
  title: withoutIsolates(text.title),
  detail: withoutIsolates(text.detail),
});
const eventLine = (...args: Parameters<typeof eventLineRaw>): string => withoutIsolates(eventLineRaw(...args));
const describeItem = (...args: Parameters<typeof describeItemRaw>): ReturnType<typeof describeItemRaw> => plain(describeItemRaw(...args));
const describeDiff = (...args: Parameters<typeof describeDiffRaw>): ReturnType<typeof describeDiffRaw> => plain(describeDiffRaw(...args));
const describeClashes = (...args: Parameters<typeof describeClashesRaw>): string[] => describeClashesRaw(...args).map(withoutIsolates);

const en = translatorFor('en');
const he = translatorFor('he');
const LANGS: Lang[] = ['en', 'he'];

const CONFIG: ScheduleConfig = {
  course: { name: 'DevOps', startDate: '2026-11-01', endDate: '2026-12-31' },
  timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
  subjects: [
    { id: 's1', name: 'Lab', color: '#16A34A' },
    { id: 's2', name: 'Lecture', color: '#2563EB' },
  ],
  locations: [
    { id: 'l1', name: 'Room 101' },
    { id: 'l2', name: 'אולם 2' },
  ],
  teachers: [{ id: 't1', name: 'Dana' }],
  classes: [{ id: 'c1', name: 'Class 1' }],
};

function ev(id: string, patch: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id,
    day: 0,
    start: 540,
    end: 630,
    title: 'Kickoff',
    subjectId: 's1',
    locationId: 'l1',
    teacherIds: ['t1'],
    classIds: ['c1'],
    notes: '',
    ...patch,
  };
}

const eventRef = (id: string, weekStart: string | undefined = W): ItemRef => ({ key: `event:${weekStart ?? ''}:${id}`, kind: 'event', id, weekStart });
const weekTitleRef = (weekStart: string | undefined = W): ItemRef => ({ key: `weekTitle:${weekStart ?? ''}`, kind: 'weekTitle', weekStart });
const scalarRef = (kind: 'course' | 'timeGrid', field: string): ItemRef => ({ key: `${kind}.${field}`, kind, field });
const entityRef = (kind: 'subject' | 'location' | 'teacher' | 'class', id: string): ItemRef => ({ key: `${kind}:${id}`, kind, id });

function diff(ref: ItemRef, before: ItemValue | undefined, after: ItemValue | undefined, changedFields: string[] = []): DiffItem {
  const change = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified';
  return { ...ref, change, before, after, changedFields };
}

describe('isEvent / isNamed', () => {
  it('tell events, list entries and scalars apart', () => {
    expect(isEvent(ev('e1'))).toBe(true);
    expect(isNamed(ev('e1'))).toBe(false);
    expect(isNamed({ id: 'l1', name: 'Room 101' })).toBe(true);
    expect(isNamed({ id: 's1', name: 'Lab', color: '#16A34A' })).toBe(true);
    expect(isEvent({ id: 'l1', name: 'Room 101' })).toBe(false);
    for (const value of ['text', '', 0, 30, null, undefined]) {
      expect(isEvent(value)).toBe(false);
      expect(isNamed(value)).toBe(false);
    }
  });
});

describe('lookupConfig', () => {
  const mine: ScheduleConfig = {
    course: { name: 'Mine', startDate: '2026-11-01', endDate: null },
    timeGrid: { dayStart: 420, dayEnd: 1080, slotMinutes: 15 },
    subjects: [{ id: 's1', name: 'Lab (mine)', color: '#DC2626' }],
    locations: [
      { id: 'l3', name: 'Room 3' },
      { id: 'l1', name: 'Room 101 renamed' },
    ],
    teachers: [],
    classes: [{ id: 'c2', name: 'Class 2' }],
  };

  it('is the union of all lists, first config wins, order of first appearance', () => {
    const merged = lookupConfig(mine, CONFIG);
    expect(merged.subjects).toEqual([
      { id: 's1', name: 'Lab (mine)', color: '#DC2626' },
      { id: 's2', name: 'Lecture', color: '#2563EB' },
    ]);
    expect(merged.locations).toEqual([
      { id: 'l3', name: 'Room 3' },
      { id: 'l1', name: 'Room 101 renamed' },
      { id: 'l2', name: 'אולם 2' },
    ]);
    expect(merged.teachers).toEqual([{ id: 't1', name: 'Dana' }]);
    expect(merged.classes).toEqual([
      { id: 'c2', name: 'Class 2' },
      { id: 'c1', name: 'Class 1' },
    ]);
  });

  it('takes course and time grid from the first config', () => {
    expect(lookupConfig(mine, CONFIG).course).toEqual(mine.course);
    expect(lookupConfig(mine, CONFIG).timeGrid).toEqual(mine.timeGrid);
    expect(lookupConfig(CONFIG, mine).course).toEqual(CONFIG.course);
    expect(lookupConfig(CONFIG, mine).timeGrid).toEqual(CONFIG.timeGrid);
  });

  it('the other order lets the other names win', () => {
    const merged = lookupConfig(CONFIG, mine);
    expect(merged.subjects[0]).toEqual({ id: 's1', name: 'Lab', color: '#16A34A' });
    expect(merged.locations.map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    expect(merged.locations[0].name).toBe('Room 101');
  });

  it('handles one config and three configs', () => {
    expect(lookupConfig(CONFIG)).toEqual(CONFIG);
    const third: ScheduleConfig = { ...CONFIG, subjects: [], locations: [], classes: [], teachers: [{ id: 't9', name: 'Noa' }, { id: 't1', name: 'Dana L.' }] };
    const merged = lookupConfig(mine, CONFIG, third);
    expect(merged.teachers).toEqual([
      { id: 't1', name: 'Dana' },
      { id: 't9', name: 'Noa' },
    ]);
    expect(merged.subjects).toHaveLength(2);
  });

  it('does not change the configs it was given', () => {
    const a = structuredClone(mine);
    const b = structuredClone(CONFIG);
    const merged = lookupConfig(a, b);
    merged.locations.push({ id: 'x', name: 'x' });
    expect(a).toEqual(mine);
    expect(b).toEqual(CONFIG);
  });

  it('never repeats an id', () => {
    const merged = lookupConfig(mine, CONFIG, mine, CONFIG);
    for (const list of [merged.subjects, merged.locations, merged.teachers, merged.classes]) {
      expect(new Set(list.map((item) => item.id)).size).toBe(list.length);
    }
  });
});

describe('fieldList', () => {
  it('names every known field', () => {
    expect(fieldList(['title', 'subjectId', 'locationId', 'teacherIds', 'classIds', 'notes', 'name', 'color'], en.t)).toBe(
      'title, subject, location, teachers, classes, notes, name, colour',
    );
    expect(fieldList(['title', 'subjectId', 'locationId', 'teacherIds', 'classIds', 'notes', 'name', 'color'], he.t)).toBe(
      'כותרת, נושא, מיקום, מורים, כיתות, הערות, שם, צבע',
    );
  });

  it('day, start, end and the "time" group all read as "time", once', () => {
    expect(fieldList(['day'], en.t)).toBe('time');
    expect(fieldList(['start'], en.t)).toBe('time');
    expect(fieldList(['end'], en.t)).toBe('time');
    expect(fieldList(['time'], en.t)).toBe('time');
    expect(fieldList(['day', 'start', 'end', 'time'], en.t)).toBe('time');
    expect(fieldList(['day', 'start', 'end'], he.t)).toBe('זמן');
  });

  it('removes duplicates and keeps the order of first appearance', () => {
    expect(fieldList(['notes', 'title', 'notes', 'title'], en.t)).toBe('notes, title');
    expect(fieldList(['start', 'locationId', 'end', 'title', 'day'], en.t)).toBe('time, location, title');
    expect(fieldList(['start', 'locationId', 'end'], he.t)).toBe('זמן, מיקום');
  });

  it('skips unknown names', () => {
    expect(fieldList([], en.t)).toBe('');
    expect(fieldList(['id'], en.t)).toBe('');
    expect(fieldList(['bogus', 'title', ''], en.t)).toBe('title');
  });

  it('skips names that only exist on Object.prototype', () => {
    expect(fieldList(['constructor', 'toString', '__proto__', 'hasOwnProperty'], en.t)).toBe('');
    expect(fieldList(['toString', 'title', 'valueOf'], en.t)).toBe('title');
  });
});

describe('scalarText', () => {
  it('missing values read as "(not set)"', () => {
    for (const ref of [scalarRef('course', 'startDate'), scalarRef('course', 'name'), scalarRef('timeGrid', 'dayStart'), weekTitleRef()]) {
      expect(scalarText(ref, undefined, en)).toBe('(not set)');
      expect(scalarText(ref, null, en)).toBe('(not set)');
      expect(scalarText(ref, null, he)).toBe('(לא הוגדר)');
    }
  });

  it('empty text reads as "(empty)"', () => {
    expect(scalarText(scalarRef('course', 'name'), '', en)).toBe('(empty)');
    expect(scalarText(weekTitleRef(), '', en)).toBe('(empty)');
    expect(scalarText(weekTitleRef(), '', he)).toBe('(ריק)');
  });

  it('plain text is shown as it is', () => {
    expect(scalarText(scalarRef('course', 'name'), 'DevOps', en)).toBe('DevOps');
    expect(scalarText(scalarRef('course', 'name'), 'קורס דבאופס', he)).toBe('קורס דבאופס');
    expect(scalarText(weekTitleRef(), 'Exam week', en)).toBe('Exam week');
    // a course that is called like a date stays text
    expect(scalarText(scalarRef('course', 'name'), '2026-11-01', en)).toBe('2026-11-01');
  });

  it('course dates are formatted for the language', () => {
    expect(scalarText(scalarRef('course', 'startDate'), '2026-11-01', en)).toBe('1 Nov 2026');
    expect(scalarText(scalarRef('course', 'endDate'), '2026-12-31', en)).toBe('31 Dec 2026');
    expect(scalarText(scalarRef('course', 'startDate'), '2026-11-01', he)).toBe(formatDate('2026-11-01', 'he'));
    expect(scalarText(scalarRef('course', 'startDate'), '2026-11-01', he)).not.toBe('1 Nov 2026');
  });

  it('grid times are clock times, the row length is minutes', () => {
    expect(scalarText(scalarRef('timeGrid', 'dayStart'), 480, en)).toBe('08:00');
    expect(scalarText(scalarRef('timeGrid', 'dayEnd'), 1440, en)).toBe('24:00');
    expect(scalarText(scalarRef('timeGrid', 'dayStart'), 0, en)).toBe('00:00');
    expect(scalarText(scalarRef('timeGrid', 'dayEnd'), 1200, he)).toBe('20:00');
    expect(scalarText(scalarRef('timeGrid', 'slotMinutes'), 30, en)).toBe('30 min');
    expect(scalarText(scalarRef('timeGrid', 'slotMinutes'), 15, he)).toBe('15 דק׳');
  });
});

describe('eventLine', () => {
  it('"Sun 22 Nov · 09:00–10:30 · Room 101"', () => {
    expect(eventLine(ev('e1'), W, CONFIG, en)).toBe('Sun 22 Nov · 09:00–10:30 · Room 101');
  });

  it('uses the date of the event\'s own day, also across a month end', () => {
    expect(eventLine(ev('e1', { day: 1 }), W, CONFIG, en)).toBe('Mon 23 Nov · 09:00–10:30 · Room 101');
    expect(eventLine(ev('e1', { day: 6 }), W, CONFIG, en)).toBe('Sat 28 Nov · 09:00–10:30 · Room 101');
    expect(eventLine(ev('e1', { day: 3 }), '2026-11-29', CONFIG, en)).toBe('Wed 2 Dec · 09:00–10:30 · Room 101');
    expect(eventLine(ev('e1', { day: 5 }), '2026-12-27', CONFIG, en)).toBe('Fri 1 Jan · 09:00–10:30 · Room 101');
  });

  it('leaves the date out when the week is unknown', () => {
    expect(eventLine(ev('e1'), undefined, CONFIG, en)).toBe('Sun · 09:00–10:30 · Room 101');
  });

  it('leaves the location out when there is none or it was deleted', () => {
    expect(eventLine(ev('e1', { locationId: null }), W, CONFIG, en)).toBe('Sun 22 Nov · 09:00–10:30');
    expect(eventLine(ev('e1', { locationId: 'gone' }), W, CONFIG, en)).toBe('Sun 22 Nov · 09:00–10:30');
    expect(eventLine(ev('e1', { locationId: null }), undefined, CONFIG, en)).toBe('Sun · 09:00–10:30');
  });

  it('shows an event that runs to midnight', () => {
    expect(eventLine(ev('e1', { start: 1380, end: 1440, locationId: null }), W, CONFIG, en)).toBe('Sun 22 Nov · 23:00–24:00');
  });

  it('Hebrew: Hebrew day and month, the same clock times', () => {
    const line = eventLine(ev('e1', { day: 2, locationId: 'l2' }), W, CONFIG, he);
    expect(line).toBe(`${dayName(2, 'he', 'short')} ${formatDayMonth('2026-11-24', 'he')} · 09:00–10:30 · אולם 2`);
    expect(line).toContain('24');
    expect(line).not.toMatch(/[A-Za-z]/);
  });
});

describe('describeItem', () => {
  it('event: headline and when / where', () => {
    expect(describeItem(eventRef('e1'), ev('e1'), CONFIG, en)).toEqual({
      title: 'Kickoff',
      detail: 'Sun 22 Nov · 09:00–10:30 · Room 101',
    });
    expect(describeItem(eventRef('e1'), ev('e1'), CONFIG, he)).toEqual({
      title: 'Kickoff',
      detail: eventLine(ev('e1'), W, CONFIG, he),
    });
  });

  it('event without a title: the subject name, else "(no title)"', () => {
    expect(describeItem(eventRef('e1'), ev('e1', { title: '' }), CONFIG, en).title).toBe('Lab');
    expect(describeItem(eventRef('e1'), ev('e1', { title: '   ' }), CONFIG, en).title).toBe('Lab');
    expect(describeItem(eventRef('e1'), ev('e1', { title: '', subjectId: null }), CONFIG, en).title).toBe('(no title)');
    expect(describeItem(eventRef('e1'), ev('e1', { title: '', subjectId: 'gone' }), CONFIG, en).title).toBe('(no title)');
    expect(describeItem(eventRef('e1'), ev('e1', { title: '', subjectId: null }), CONFIG, he).title).toBe('(ללא כותרת)');
  });

  it('event ref without an event value', () => {
    expect(describeItem(eventRef('e1'), undefined, CONFIG, en)).toEqual({ title: '(no title)', detail: '' });
    expect(describeItem(eventRef('e1'), null, CONFIG, he)).toEqual({ title: '(ללא כותרת)', detail: '' });
    expect(describeItem(eventRef('e1'), 'damaged', CONFIG, en)).toEqual({ title: '(no title)', detail: '' });
    expect(describeItem(eventRef('e1'), { id: 'l1', name: 'Room 101' }, CONFIG, en)).toEqual({ title: '(no title)', detail: '' });
  });

  it('week title', () => {
    for (const lang of LANGS) {
      const tr = translatorFor(lang);
      const text = describeItem(weekTitleRef(), 'Exam week', CONFIG, tr);
      expect(text.title).toBe(tr.t('sync.itemWeekTitle', { week: formatWeekRange(W, lang) }));
      expect(text.title).toContain(formatWeekRange(W, lang));
      expect(text.detail).toBe('Exam week');
    }
    expect(describeItem(weekTitleRef(), 'Exam week', CONFIG, en).title).toMatch(/^Name of the week 22\s*–\s*28 Nov 2026$/);
    expect(describeItem(weekTitleRef(), 'Exam week', CONFIG, he).title.startsWith('שם השבוע ')).toBe(true);
    expect(describeItem(weekTitleRef(), '', CONFIG, en).detail).toBe('(empty)');
    expect(describeItem(weekTitleRef(), undefined, CONFIG, en).detail).toBe('(not set)');
  });

  it('week title without a week does not throw', () => {
    // written out: the helper's default parameter would fill in a week for `undefined`
    const text = describeItem({ key: 'weekTitle:', kind: 'weekTitle' }, 'Exam week', CONFIG, en);
    expect(text.title.trim()).toBe('Name of the week');
    expect(text.detail).toBe('Exam week');
  });

  it.each([
    ['course', 'name', 'DevOps', 'Course name', 'שם הקורס', 'DevOps'],
    ['course', 'startDate', '2026-11-01', 'Course start date', 'תאריך תחילת הקורס', '1 Nov 2026'],
    ['course', 'endDate', '2026-12-31', 'Course end date', 'תאריך סיום הקורס', '31 Dec 2026'],
    ['timeGrid', 'dayStart', 480, 'Day starts at', 'תחילת היום', '08:00'],
    ['timeGrid', 'dayEnd', 1200, 'Day ends at', 'סיום היום', '20:00'],
    ['timeGrid', 'slotMinutes', 45, 'Length of a row', 'אורך שורה', '45 min'],
  ] as const)('%s.%s', (kind, field, value, titleEn, titleHe, detailEn) => {
    const ref = scalarRef(kind, field);
    expect(describeItem(ref, value, CONFIG, en)).toEqual({ title: titleEn, detail: detailEn });
    const hebrew = describeItem(ref, value, CONFIG, he);
    expect(hebrew.title).toBe(titleHe);
    expect(hebrew.detail).toBe(scalarText(ref, value, he));
    expect(describeItem(ref, null, CONFIG, en)).toEqual({ title: titleEn, detail: '(not set)' });
  });

  it('an unknown scalar key falls back to the key itself', () => {
    expect(describeItem(scalarRef('course', 'motto'), 'x', CONFIG, en)).toEqual({ title: 'course.motto', detail: 'x' });
  });

  it.each([
    ['subject', { id: 's1', name: 'Lab', color: '#16A34A' }, 'Subject: Lab', 'נושא: Lab'],
    ['location', { id: 'l1', name: 'Room 101' }, 'Location: Room 101', 'מיקום: Room 101'],
    ['teacher', { id: 't1', name: 'Dana' }, 'Teacher: Dana', 'מורה: Dana'],
    ['class', { id: 'c1', name: 'Class 1' }, 'Class: Class 1', 'כיתה: Class 1'],
  ] as const)('%s', (kind, value, titleEn, titleHe) => {
    const ref = entityRef(kind, value.id);
    expect(describeItem(ref, value, CONFIG, en)).toEqual({ title: titleEn, detail: '' });
    expect(describeItem(ref, value, CONFIG, he)).toEqual({ title: titleHe, detail: '' });
    expect(describeItem(ref, undefined, CONFIG, en)).toEqual({ title: `${titleEn.split(':')[0]}: Unknown`, detail: '' });
    expect(describeItem(ref, undefined, CONFIG, he)).toEqual({ title: `${titleHe.split(':')[0]}: לא ידוע`, detail: '' });
  });

  it('uses the name of the given version, not the one in the config', () => {
    expect(describeItem(entityRef('location', 'l1'), { id: 'l1', name: 'Auditorium' }, CONFIG, en).title).toBe('Location: Auditorium');
  });
});

describe('describeDiff', () => {
  it('course field: old → new', () => {
    const item = diff(scalarRef('course', 'startDate'), null, '2026-11-01');
    expect(describeDiff(item, CONFIG, en)).toEqual({ title: 'Course start date', detail: '(not set) → 1 Nov 2026' });
    expect(describeDiff(item, CONFIG, he)).toEqual({
      title: 'תאריך תחילת הקורס',
      detail: `(לא הוגדר) ← ${formatDate('2026-11-01', 'he')}`,
    });
    expect(describeDiff(diff(scalarRef('course', 'endDate'), '2026-12-31', null), CONFIG, en)).toEqual({
      title: 'Course end date',
      detail: '31 Dec 2026 → (not set)',
    });
    expect(describeDiff(diff(scalarRef('course', 'name'), '', 'DevOps'), CONFIG, en)).toEqual({
      title: 'Course name',
      detail: '(empty) → DevOps',
    });
    expect(describeDiff(diff(scalarRef('course', 'name'), 'DevOps', 'DevOps 2'), CONFIG, he)).toEqual({
      title: 'שם הקורס',
      detail: 'DevOps ← DevOps 2',
    });
  });

  it('time grid field: old → new', () => {
    expect(describeDiff(diff(scalarRef('timeGrid', 'slotMinutes'), 30, 15), CONFIG, en)).toEqual({
      title: 'Length of a row',
      detail: '30 min → 15 min',
    });
    expect(describeDiff(diff(scalarRef('timeGrid', 'slotMinutes'), 30, 15), CONFIG, he)).toEqual({
      title: 'אורך שורה',
      detail: '30 דק׳ ← 15 דק׳',
    });
    expect(describeDiff(diff(scalarRef('timeGrid', 'dayStart'), 480, 420), CONFIG, en)).toEqual({
      title: 'Day starts at',
      detail: '08:00 → 07:00',
    });
    expect(describeDiff(diff(scalarRef('timeGrid', 'dayEnd'), 1200, 1440), CONFIG, he)).toEqual({
      title: 'סיום היום',
      detail: '20:00 ← 24:00',
    });
  });

  it('week title: added, renamed, removed', () => {
    const title = describeItem(weekTitleRef(), 'x', CONFIG, en).title;
    expect(describeDiff(diff(weekTitleRef(), undefined, 'Exams'), CONFIG, en)).toEqual({ title, detail: '(not set) → Exams' });
    expect(describeDiff(diff(weekTitleRef(), 'Exams', 'Finals'), CONFIG, en)).toEqual({ title, detail: 'Exams → Finals' });
    expect(describeDiff(diff(weekTitleRef(), 'Exams', undefined), CONFIG, en)).toEqual({ title, detail: 'Exams → (not set)' });
    expect(describeDiff(diff(weekTitleRef(), 'Exams', ''), CONFIG, en)).toEqual({ title, detail: 'Exams → (empty)' });
    const hebrew = describeDiff(diff(weekTitleRef(), 'מבחנים', undefined), CONFIG, he);
    expect(hebrew.title).toBe(describeItem(weekTitleRef(), 'x', CONFIG, he).title);
    expect(hebrew.detail).toBe('מבחנים ← (לא הוגדר)');
  });

  it.each([
    ['subject', { id: 's9', name: 'Maths', color: '#DC2626' }, 'Subject: Maths', 'נושא: Maths'],
    ['location', { id: 'l9', name: 'Gym' }, 'Location: Gym', 'מיקום: Gym'],
    ['teacher', { id: 't9', name: 'Noa' }, 'Teacher: Noa', 'מורה: Noa'],
    ['class', { id: 'c9', name: 'Class 9' }, 'Class: Class 9', 'כיתה: Class 9'],
  ] as const)('%s added and deleted: just what it is', (kind, value, titleEn, titleHe) => {
    const ref = entityRef(kind, value.id);
    expect(describeDiff(diff(ref, undefined, value), CONFIG, en)).toEqual({ title: titleEn, detail: '' });
    expect(describeDiff(diff(ref, value, undefined), CONFIG, en)).toEqual({ title: titleEn, detail: '' });
    expect(describeDiff(diff(ref, undefined, value), CONFIG, he)).toEqual({ title: titleHe, detail: '' });
    expect(describeDiff(diff(ref, value, undefined), CONFIG, he)).toEqual({ title: titleHe, detail: '' });
  });

  it('list entry modified: the new name and what changed', () => {
    const before = { id: 's1', name: 'Lab', color: '#16A34A' };
    const after = { id: 's1', name: 'Laboratory', color: '#DC2626' };
    expect(describeDiff(diff(entityRef('subject', 's1'), before, after, ['name', 'color']), CONFIG, en)).toEqual({
      title: 'Subject: Laboratory',
      detail: 'changed: name, colour',
    });
    expect(describeDiff(diff(entityRef('subject', 's1'), before, after, ['name', 'color']), CONFIG, he)).toEqual({
      title: 'נושא: Laboratory',
      detail: 'שונו: שם, צבע',
    });
    expect(describeDiff(diff(entityRef('subject', 's1'), before, { ...before, color: '#DC2626' }, ['color']), CONFIG, en)).toEqual({
      title: 'Subject: Lab',
      detail: 'changed: colour',
    });
    expect(
      describeDiff(diff(entityRef('teacher', 't1'), { id: 't1', name: 'Dana' }, { id: 't1', name: 'Dana L.' }, ['name']), CONFIG, en),
    ).toEqual({ title: 'Teacher: Dana L.', detail: 'changed: name' });
  });

  it('event added and deleted: the event line of the version that exists', () => {
    const added = ev('e1');
    expect(describeDiff(diff(eventRef('e1'), undefined, added), CONFIG, en)).toEqual({
      title: 'Kickoff',
      detail: 'Sun 22 Nov · 09:00–10:30 · Room 101',
    });
    const deleted = ev('e2', { title: 'Old', day: 4, start: 600, end: 660, locationId: null });
    expect(describeDiff(diff(eventRef('e2'), deleted, undefined), CONFIG, en)).toEqual({
      title: 'Old',
      detail: 'Thu 26 Nov · 10:00–11:00',
    });
    expect(describeDiff(diff(eventRef('e2'), deleted, undefined), CONFIG, he)).toEqual({
      title: 'Old',
      detail: eventLine(deleted, W, CONFIG, he),
    });
  });

  it('event modified: the new version plus the changed fields, time named once', () => {
    const before = ev('e1');
    const after = ev('e1', { day: 1, start: 600, end: 690, locationId: 'l2' });
    const item = diff(eventRef('e1'), before, after, ['day', 'start', 'end', 'locationId']);
    expect(describeDiff(item, CONFIG, en)).toEqual({
      title: 'Kickoff',
      detail: 'Mon 23 Nov · 10:00–11:30 · אולם 2 · changed: time, location',
    });
    expect(describeDiff(item, CONFIG, he)).toEqual({
      title: 'Kickoff',
      detail: `${eventLine(after, W, CONFIG, he)} · שונו: זמן, מיקום`,
    });
  });

  it('event modified, every field', () => {
    const after = ev('e1', { title: 'Kick-off' });
    const item = diff(eventRef('e1'), ev('e1'), after, ['day', 'start', 'end', 'title', 'subjectId', 'locationId', 'teacherIds', 'classIds', 'notes']);
    expect(describeDiff(item, CONFIG, en).detail).toBe(
      'Sun 22 Nov · 09:00–10:30 · Room 101 · changed: time, title, subject, location, teachers, classes, notes',
    );
    expect(describeDiff(item, CONFIG, en).title).toBe('Kick-off');
  });

  it('event modified without known changed fields: no dangling "changed:"', () => {
    const line = 'Sun 22 Nov · 09:00–10:30 · Room 101';
    expect(describeDiff(diff(eventRef('e1'), ev('e1'), ev('e1', { notes: 'x' }), []), CONFIG, en).detail).toBe(line);
    expect(describeDiff(diff(eventRef('e1'), ev('e1'), ev('e1', { notes: 'x' }), ['bogus']), CONFIG, en).detail).toBe(line);
  });

  it('list entry modified without known changed fields: empty detail', () => {
    const item = diff(entityRef('location', 'l1'), { id: 'l1', name: 'Room 101' }, { id: 'l1', name: 'Room 101' }, []);
    expect(describeDiff(item, CONFIG, en)).toEqual({ title: 'Location: Room 101', detail: '' });
  });

  it('changed fields are not listed for added or deleted items', () => {
    const item: DiffItem = { ...eventRef('e1'), change: 'added', before: undefined, after: ev('e1'), changedFields: ['title'] };
    expect(describeDiff(item, CONFIG, en).detail).toBe('Sun 22 Nov · 09:00–10:30 · Room 101');
  });
});

describe('describeClashes', () => {
  const events: ScheduleEvent[] = [
    ev('e1'),
    ev('e2', { title: 'Lab session' }),
    ev('e3', { title: '', subjectId: 's2' }),
    ev('e4', { title: '', subjectId: null }),
  ];
  const clash = (reason: Clash['reason'], sharedId: string, otherId: string): Clash => ({ reason, sharedId, otherId });

  it('nothing to say without clashes', () => {
    expect(describeClashes([], events, CONFIG, en.t)).toEqual([]);
  });

  it('one sentence per reason, English', () => {
    expect(
      describeClashes([clash('location', 'l1', 'e2'), clash('teacher', 't1', 'e2'), clash('class', 'c1', 'e2')], events, CONFIG, en.t),
    ).toEqual([
      'Room 101 is also used by "Lab session" at this time',
      'Dana also teaches "Lab session" at this time',
      'Class 1 also has "Lab session" at this time',
    ]);
  });

  it('one sentence per reason, Hebrew', () => {
    expect(
      describeClashes([clash('location', 'l1', 'e2'), clash('teacher', 't1', 'e2'), clash('class', 'c1', 'e2')], events, CONFIG, he.t),
    ).toEqual([
      'Room 101 משמש באותו זמן גם את ״Lab session״',
      'Dana מלמד/ת באותו זמן גם את ״Lab session״',
      'ל-Class 1 יש באותו זמן גם את ״Lab session״',
    ]);
  });

  it('names the other event by its subject when it has no title, else "(no title)"', () => {
    expect(describeClashes([clash('location', 'l1', 'e3')], events, CONFIG, en.t)).toEqual([
      'Room 101 is also used by "Lecture" at this time',
    ]);
    expect(describeClashes([clash('location', 'l1', 'e4')], events, CONFIG, en.t)).toEqual([
      'Room 101 is also used by "(no title)" at this time',
    ]);
    expect(describeClashes([clash('location', 'l1', 'e4')], events, CONFIG, he.t)).toEqual([
      'Room 101 משמש באותו זמן גם את ״(ללא כותרת)״',
    ]);
  });

  it('says "Unknown" for an event or a list entry that cannot be found', () => {
    expect(describeClashes([clash('teacher', 't1', 'nope')], events, CONFIG, en.t)).toEqual(['Dana also teaches "Unknown" at this time']);
    expect(describeClashes([clash('teacher', 'gone', 'e2')], events, CONFIG, en.t)).toEqual([
      'Unknown also teaches "Lab session" at this time',
    ]);
    expect(describeClashes([clash('class', 'gone', 'nope')], [], CONFIG, he.t)).toEqual(['ל-לא ידוע יש באותו זמן גם את ״לא ידוע״']);
  });

  it('looks the shared id up in the list that belongs to the reason', () => {
    // 'l1' is a location, not a teacher
    expect(describeClashes([clash('teacher', 'l1', 'e2')], events, CONFIG, en.t)).toEqual([
      'Unknown also teaches "Lab session" at this time',
    ]);
  });

  it('says the same sentence only once and keeps the order', () => {
    const twoEventsSameTitle = [ev('a', { title: 'Lab session' }), ev('b', { title: 'Lab session' }), ev('c', { title: 'Other' })];
    expect(
      describeClashes(
        [clash('location', 'l1', 'a'), clash('teacher', 't1', 'c'), clash('location', 'l1', 'b'), clash('location', 'l1', 'a')],
        twoEventsSameTitle,
        CONFIG,
        en.t,
      ),
    ).toEqual(['Room 101 is also used by "Lab session" at this time', 'Dana also teaches "Other" at this time']);
  });
});
