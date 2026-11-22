/**
 * A week file can come from anywhere — another team, a text editor. What it brings in is
 * held to the rules of the editor: text lengths, the quarter-hour grid, plain ids.
 * (Found by an independent review: a loaded file used to bypass every one of them.)
 */
import { describe, expect, it } from 'vitest';
import { getWeek } from '@shared/model';
import { emptyDataset } from '@shared/serialize';
import type { Dataset } from '@shared/types';
import { TEXT_LIMITS, WEEK_TEMPLATE_TYPE, importWeekTemplate, isPlainId, parseWeekTemplate, type TemplateEvent, type WeekTemplate } from '@shared/weekTemplate';

const TARGET = '2026-11-29';

function templateEvent(overrides: Partial<TemplateEvent> = {}): TemplateEvent {
  return { day: 1, start: '09:00', end: '10:00', title: 'Imported', notes: '', subject: null, location: null, teachers: [], classes: [], ...overrides };
}

function template(events: TemplateEvent[], title = ''): WeekTemplate {
  return { type: WEEK_TEMPLATE_TYPE, formatVersion: 1, exportedAt: '2026-11-21T10:00:00.000Z', sourceWeek: '2026-11-22', title, events };
}

function load(file: WeekTemplate, into: Dataset = emptyDataset(), applyTitle = true) {
  let n = 0;
  return importWeekTemplate(into, file, { targetWeek: TARGET, mode: 'add', applyTitle }, () => `new${++n}`);
}

const minutes = (text: string): number => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));

describe('times land on the quarter hour', () => {
  it.each([
    ['10:07', '10:22', '10:00', '10:15'],
    ['10:08', '10:22', '10:15', '10:30'],
    ['00:00', '00:01', '00:00', '00:15'],
    ['09:05', '24:00', '09:00', '24:00'],
    ['23:55', '24:00', '23:45', '24:00'],
    ['08:53', '08:58', '09:00', '09:15'],
  ])('%s–%s becomes %s–%s', (start, end, expectedStart, expectedEnd) => {
    const result = load(template([templateEvent({ start, end })]));
    const [event] = getWeek(result.dataset, TARGET).events;
    expect([event.start, event.end]).toEqual([minutes(expectedStart), minutes(expectedEnd)]);
    expect(result.snapped).toBe(1);
  });

  it('times that are on the grid are left alone and not counted', () => {
    const result = load(template([templateEvent({ start: '09:15', end: '10:45' }), templateEvent({ day: 2, start: '00:00', end: '24:00' })]));
    expect(getWeek(result.dataset, TARGET).events.map((event) => [event.start, event.end])).toEqual([
      [555, 645],
      [0, 1440],
    ]);
    expect(result.snapped).toBe(0);
  });

  it('counts every event that was moved', () => {
    const result = load(template([templateEvent({ start: '10:07', end: '10:22' }), templateEvent({ start: '11:00', end: '12:00' }), templateEvent({ start: '13:01', end: '14:00' })]));
    expect(result.snapped).toBe(2);
    expect(result.eventCount).toBe(3);
  });
});

describe('texts are cut to what the editor allows', () => {
  it('event title, notes, week title and the names of new list entries', () => {
    const result = load(
      template(
        [
          templateEvent({
            title: 'T'.repeat(410),
            notes: 'N'.repeat(5000),
            location: { id: 'loc1234567', name: 'L'.repeat(300) },
            teachers: [{ id: 'tea1234567', name: 'Dana' }],
          }),
        ],
        'W'.repeat(359),
      ),
    );
    const week = getWeek(result.dataset, TARGET);
    expect(week.title).toHaveLength(TEXT_LIMITS.weekTitle);
    expect(week.events[0].title).toHaveLength(TEXT_LIMITS.eventTitle);
    expect(week.events[0].notes).toHaveLength(TEXT_LIMITS.notes);
    expect(result.dataset.config.locations[0].name).toHaveLength(TEXT_LIMITS.entityName);
    expect(result.dataset.config.teachers[0].name).toBe('Dana');
    expect(result.shortened).toBe(4);
  });

  it('the limits are the ones of the editor', () => {
    expect(TEXT_LIMITS).toEqual({ weekTitle: 120, eventTitle: 200, notes: 2000, entityName: 80 });
  });

  it('texts within the limits are not touched and not counted', () => {
    const result = load(template([templateEvent({ title: 'x'.repeat(200), notes: 'y'.repeat(2000) })], 'z'.repeat(120)));
    const week = getWeek(result.dataset, TARGET);
    expect([week.title.length, week.events[0].title.length, week.events[0].notes.length]).toEqual([120, 200, 2000]);
    expect(result.shortened).toBe(0);
  });

  it('never cuts through the middle of an emoji', () => {
    const smile = String.fromCodePoint(0x1f600);
    const result = load(template([templateEvent({ title: 'a'.repeat(199) + smile })]));
    const title = getWeek(result.dataset, TARGET).events[0].title;
    expect(title).toBe('a'.repeat(199));
    expect(JSON.parse(JSON.stringify(title))).toBe(title);
  });

  it('a week title that is not applied is not counted', () => {
    const result = load(template([templateEvent()], 'W'.repeat(359)), emptyDataset(), false);
    expect(result.shortened).toBe(0);
    expect(getWeek(result.dataset, TARGET).title).toBe('');
  });
});

describe('ids of new list entries', () => {
  it('isPlainId: letters, digits, _ and - of a sensible length, and no name every object has', () => {
    for (const id of ['k3x9p2aqz1', 'a', 'Room_1', 'room-1', 'A1', 'x'.repeat(64)]) expect(isPlainId(id)).toBe(true);
    for (const id of ['', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'has space', 'a/b', 'a.b', 'שלום', 'x'.repeat(65), 'a\nb']) {
      expect(isPlainId(id)).toBe(false);
    }
  });

  it('an id that is no plain id is replaced by a fresh one', () => {
    const result = load(
      template([
        templateEvent({
          teachers: [
            { id: '__proto__', name: 'Proto teacher' },
            { id: 'constructor', name: 'Ctor teacher' },
            { id: 'has space', name: 'Spaced teacher' },
            { id: '', name: 'Nameless id' },
          ],
        }),
      ]),
    );
    const teachers = result.dataset.config.teachers;
    expect(teachers.map((teacher) => teacher.name)).toEqual(['Proto teacher', 'Ctor teacher', 'Spaced teacher', 'Nameless id']);
    for (const teacher of teachers) expect(isPlainId(teacher.id)).toBe(true);
    expect(new Set(teachers.map((teacher) => teacher.id)).size).toBe(4);
    // The event points to exactly those entries.
    expect([...getWeek(result.dataset, TARGET).events[0].teacherIds].sort()).toEqual(teachers.map((teacher) => teacher.id).sort());
    expect(Object.getPrototypeOf(result.dataset.config.teachers)).toBe(Array.prototype);
  });

  it('a plain id from the file is still kept, so the same file loaded twice finds its entries again', () => {
    const file = template([templateEvent({ location: { id: 'a1b2c3d4e5', name: 'Room 101' } })]);
    const first = load(file);
    expect(first.dataset.config.locations).toEqual([{ id: 'a1b2c3d4e5', name: 'Room 101' }]);
    const second = load(file, first.dataset);
    expect(second.dataset.config.locations).toEqual([{ id: 'a1b2c3d4e5', name: 'Room 101' }]);
    expect(second.created.locations).toBe(0);
  });
});

describe('a real file from elsewhere, end to end', () => {
  it('is read, and everything in it is brought to the rules', () => {
    const text = JSON.stringify({
      type: WEEK_TEMPLATE_TYPE,
      formatVersion: 1,
      sourceWeek: '2026-11-22',
      title: '  Exam week  ',
      events: [
        { day: 3, start: '10:07', end: '10:22', title: '  Off-grid minutes  ', teachers: [{ id: '__proto__', name: 'Proto teacher' }] },
        { day: 4, start: '0:00', end: '0:01', notes: 'x'.repeat(2001) },
      ],
    });
    const result = load(parseWeekTemplate(text));
    const week = getWeek(result.dataset, TARGET);
    expect(week.title).toBe('Exam week');
    expect(week.events.map((event) => [event.day, event.start, event.end, event.title])).toEqual([
      [3, 600, 615, 'Off-grid minutes'],
      [4, 0, 15, ''],
    ]);
    expect(result.snapped).toBe(2);
    expect(result.shortened).toBe(1);
    expect(isPlainId(result.dataset.config.teachers[0].id)).toBe(true);
  });
});

describe('one over-long name used by several lessons of a file', () => {
  const LONG = `Dr. ${'x'.repeat(100)}`; // 104 characters, the editor allows 80

  it.each([
    ['an id the import does not keep', 'teacher.1'],
    ['an empty id', ''],
    ['a plain id', 'abc123'],
  ])('%s: the three lessons get ONE new teacher, and the cut is counted once', (_what, id) => {
    const events = [0, 1, 2].map((day) => templateEvent({ day: day as TemplateEvent['day'], teachers: [{ id, name: LONG }] }));
    const result = load(template(events));
    const teachers = result.dataset.config.teachers;

    expect(result.created.teachers).toBe(1);
    expect(teachers).toHaveLength(1);
    expect(teachers[0].name).toHaveLength(TEXT_LIMITS.entityName);
    for (const event of getWeek(result.dataset, TARGET).events) expect(event.teacherIds).toEqual([teachers[0].id]);
    expect(result.shortened).toBe(1);
  });

  it('loading the same file again, or another file with the same long name, adds nothing', () => {
    const once = load(template([templateEvent({ teachers: [{ id: 'abc123', name: LONG }] })]));
    const twice = load(template([templateEvent({ teachers: [{ id: 'abc123', name: LONG }] })]), once.dataset);
    const other = load(template([templateEvent({ teachers: [{ id: 'zzz999', name: LONG }] })]), twice.dataset);

    expect(other.dataset.config.teachers).toHaveLength(1);
    expect([twice.created.teachers, other.created.teachers]).toEqual([0, 0]);
    // Nothing new was cut either: the entry was found under its stored name.
    expect([twice.shortened, other.shortened]).toEqual([0, 0]);
  });

  it('a name that is only blanks after the cut cannot become an entry', () => {
    const result = load(template([templateEvent({ location: { id: 'loc1234567', name: '   ' } })]));
    expect(result.dataset.config.locations).toEqual([]);
    expect(getWeek(result.dataset, TARGET).events[0].locationId).toBeNull();
  });
});
