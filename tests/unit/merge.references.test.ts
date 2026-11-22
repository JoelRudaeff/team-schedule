/**
 * What must hold after a merge and after "use my version", whatever the two sides did to a
 * teacher, room, class or subject: no event is left pointing at nothing, nobody loses
 * assignments through the back door, the lists do not end up with the same name twice, and
 * the course never ends before it starts.
 *
 * Every case here was found broken by an independent review of version 1.0.0.
 */
import { describe, expect, it } from 'vitest';
import { applyAsideItem, applyMerge, mergeDatasets, type AsideItem, type Resolution } from '@shared/merge';
import {
  addEntity,
  countEntityUsage,
  entityList,
  findEntity,
  findEvent,
  referencedIds,
  removeEntity,
  updateCourse,
  updateEntity,
  upsertEvent,
} from '@shared/model';
import { datasetToFiles, emptyDataset, filesToDataset } from '@shared/serialize';
import type { Dataset, EntityKind, ScheduleEvent } from '@shared/types';

const WEEK = '2026-11-22';
const NOW = '2026-11-22T00:00:00.000Z';
const KINDS: EntityKind[] = ['subject', 'location', 'teacher', 'class'];

function ev(id: string, day: number, extra: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id,
    day: day as ScheduleEvent['day'],
    start: 540,
    end: 600,
    title: id,
    subjectId: null,
    locationId: null,
    teacherIds: [],
    classIds: [],
    notes: '',
    ...extra,
  };
}

/** Teachers Dana (T) and Uri (U); Dana teaches five lessons. */
function baseWithTeacher(): Dataset {
  let dataset = emptyDataset();
  dataset = addEntity(dataset, 'teacher', { id: 'T', name: 'Dana' });
  dataset = addEntity(dataset, 'teacher', { id: 'U', name: 'Uri' });
  for (let i = 0; i < 5; i++) dataset = upsertEvent(dataset, WEEK, ev(`e${i}`, i, { teacherIds: ['T'] }));
  return dataset;
}

function merge(base: Dataset, mine: Dataset, theirs: Dataset, defaultResolution: Resolution, resolutions: Record<string, Resolution> = {}) {
  const result = mergeDatasets(base, mine, theirs);
  return { result, applied: applyMerge({ mine, theirs, result, resolutions, defaultResolution, now: NOW }) };
}

/** Every reference of every event that points at an entry the lists do not have. */
function dangling(dataset: Dataset): string[] {
  const found: string[] = [];
  for (const [weekStart, week] of Object.entries(dataset.weeks)) {
    for (const event of week.events) {
      for (const kind of KINDS) {
        for (const id of referencedIds(event, kind)) {
          if (!findEntity(dataset.config, kind, id)) found.push(`${weekStart}/${event.id} -> ${kind} ${id}`);
        }
      }
    }
  }
  return found;
}

describe('one side deletes a list entry, the other side changes it', () => {
  it('the team deletes a teacher, I rename her and my version wins: she keeps her five lessons', () => {
    const base = baseWithTeacher();
    const mine = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const theirs = removeEntity(base, 'teacher', 'T');
    const { result, applied } = merge(base, mine, theirs, 'mine');

    expect(result.items.filter((item) => item.status === 'conflict').map((item) => item.key)).toEqual(['teacher:T']);
    expect(findEntity(applied.dataset.config, 'teacher', 'T')).toEqual({ id: 'T', name: 'Dana Levi' });
    // Deleting her had taken her out of every event on the team's side. She stays, so do her lessons.
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(5);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it.each(['theirs', 'aside'] as const)('I delete a teacher, the team renames her, resolved as "%s": she keeps her five lessons', (resolution) => {
    const base = baseWithTeacher();
    const mine = removeEntity(base, 'teacher', 'T');
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, resolution);

    expect(findEntity(applied.dataset.config, 'teacher', 'T')).toEqual({ id: 'T', name: 'Dana Levi' });
    // My deletion did not happen, so neither does its side effect on the team's events.
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(5);
    expect(applied.aside.map((item) => item.key)).toEqual(resolution === 'aside' ? ['teacher:T'] : []);
    // Nothing of this is left for me to publish.
    expect(applied.dataset).toEqual(theirs);
  });

  it('the deletion wins: the entry is gone and nothing points at it', () => {
    const base = baseWithTeacher();
    const mine = removeEntity(base, 'teacher', 'T');
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'mine');

    expect(findEntity(applied.dataset.config, 'teacher', 'T')).toBeUndefined();
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(0);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it('a lesson that the keeping side had given to somebody else is not handed back', () => {
    const base = baseWithTeacher();
    // I rename Dana and move e0 from her to Uri; the team deletes her.
    let mine = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    mine = upsertEvent(mine, WEEK, ev('e0', 0, { teacherIds: ['U'] }));
    const theirs = removeEntity(base, 'teacher', 'T');
    const { applied } = merge(base, mine, theirs, 'mine');

    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['U']);
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(4);
  });

  it('works the same for the single-valued references (location, subject)', () => {
    let base = emptyDataset();
    base = addEntity(base, 'location', { id: 'L', name: 'Room 1' });
    base = addEntity(base, 'subject', { id: 'S', name: 'Lab', color: '#16A34A' });
    base = upsertEvent(base, WEEK, ev('a', 0, { locationId: 'L', subjectId: 'S' }));
    const mine = updateEntity(updateEntity(base, 'location', 'L', { name: 'Room 1 (lab)' }), 'subject', 'S', { name: 'Laboratory' });
    const theirs = removeEntity(removeEntity(base, 'location', 'L'), 'subject', 'S');
    const { applied } = merge(base, mine, theirs, 'mine');

    expect(findEvent(applied.dataset, WEEK, 'a')).toMatchObject({ locationId: 'L', subjectId: 'S' });
    expect(dangling(applied.dataset)).toEqual([]);
  });
});

describe('"use my version" of something that was kept aside', () => {
  /** The team deleted Dana; I had put Dana and Uri on e0. My e0 was kept aside. */
  function asideEvent(): { dataset: Dataset; item: AsideItem } {
    const base = baseWithTeacher();
    const theirs = removeEntity(base, 'teacher', 'T');
    const mine = upsertEvent(base, WEEK, ev('e0', 0, { teacherIds: ['T', 'U'], title: 'Mine' }));
    const { applied } = merge(base, mine, theirs, 'aside');
    expect(applied.aside.map((item) => item.key)).toEqual([`event:${WEEK}:e0`]);
    expect(findEntity(applied.dataset.config, 'teacher', 'T')).toBeUndefined();
    return { dataset: applied.dataset, item: applied.aside[0] };
  }

  it('an event kept aside remembers the list entries it uses', () => {
    const { item } = asideEvent();
    expect(item.entities).toEqual([
      { kind: 'teacher', value: { id: 'T', name: 'Dana' } },
      { kind: 'teacher', value: { id: 'U', name: 'Uri' } },
    ]);
  });

  it('my event comes back whole: a teacher who was deleted meanwhile is restored with it', () => {
    const { dataset, item } = asideEvent();
    const after = applyAsideItem(dataset, item);

    expect(findEvent(after, WEEK, 'e0')).toMatchObject({ title: 'Mine', teacherIds: ['T', 'U'] });
    expect(findEntity(after.config, 'teacher', 'T')).toEqual({ id: 'T', name: 'Dana' });
    expect(dangling(after)).toEqual([]);
  });

  it('when the list meanwhile has an entry of that name again, my event points to that one', () => {
    const { dataset, item } = asideEvent();
    const readded = addEntity(dataset, 'teacher', { id: 'T2', name: ' dana ' });
    const after = applyAsideItem(readded, item);

    expect(findEvent(after, WEEK, 'e0')?.teacherIds).toEqual(['T2', 'U']);
    expect(entityList(after.config, 'teacher').map((teacher) => teacher.id)).toEqual(['U', 'T2']);
    expect(dangling(after)).toEqual([]);
  });

  it('an entry nothing is known about (kept aside by an older version of the app) is left out, not left dangling', () => {
    const { dataset, item } = asideEvent();
    const old: AsideItem = { ...item };
    delete old.entities;
    const after = applyAsideItem(dataset, old);

    expect(findEvent(after, WEEK, 'e0')).toMatchObject({ title: 'Mine', teacherIds: ['U'] });
    expect(dangling(after)).toEqual([]);
  });

  it('my deletion of a list entry takes it out of every event, exactly like removing it in Settings', () => {
    const base = baseWithTeacher();
    const mine = removeEntity(base, 'teacher', 'T');
    // The team renames her and gives her one more lesson.
    const theirs = upsertEvent(updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' }), WEEK, ev('new', 6, { teacherIds: ['T'] }));
    const { applied } = merge(base, mine, theirs, 'aside');
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(6);

    const after = applyAsideItem(applied.dataset, applied.aside[0]);
    expect(findEntity(after.config, 'teacher', 'T')).toBeUndefined();
    expect(countEntityUsage(after, 'teacher', 'T')).toBe(0);
    expect(dangling(after)).toEqual([]);
    expect(after).toEqual(removeEntity(applied.dataset, 'teacher', 'T'));
  });

  it('a course date that would make the course end before it starts is refused (the same dataset comes back)', () => {
    const dataset = updateCourse(emptyDataset(), { startDate: '2026-09-06', endDate: '2026-12-31' });
    const item: AsideItem = { key: 'course.startDate', kind: 'course', field: 'startDate', mine: '2027-01-10', theirs: '2026-09-06', createdAt: NOW };
    expect(applyAsideItem(dataset, item)).toBe(dataset);
    // A date that fits is taken.
    const fits: AsideItem = { ...item, mine: '2026-10-04' };
    expect(applyAsideItem(dataset, fits).config.course.startDate).toBe('2026-10-04');
  });
});

describe('two people add the same room', () => {
  it('my entry is folded into the team\'s: one name, and my lessons use the team\'s entry', () => {
    const base = emptyDataset();
    const mine = upsertEvent(addEntity(base, 'location', { id: 'mine000001', name: 'Room 101' }), WEEK, ev('m', 0, { locationId: 'mine000001' }));
    const theirs = upsertEvent(addEntity(base, 'location', { id: 'their00001', name: 'Room 101' }), WEEK, ev('t', 1, { locationId: 'their00001' }));
    const { result, applied } = merge(base, mine, theirs, 'theirs');

    expect(result.conflictCount).toBe(0);
    expect(applied.dataset.config.locations).toEqual([{ id: 'their00001', name: 'Room 101' }]);
    expect(findEvent(applied.dataset, WEEK, 'm')?.locationId).toBe('their00001');
    expect(findEvent(applied.dataset, WEEK, 't')?.locationId).toBe('their00001');
    expect(applied.notes).toEqual([{ code: 'entity-merged', kind: 'location', id: 'their00001', name: 'Room 101' }]);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it('upper / lower case and blanks around the name do not make it another room', () => {
    const base = emptyDataset();
    const mine = addEntity(base, 'location', { id: 'mine000001', name: 'lab x' });
    const theirs = addEntity(base, 'location', { id: 'their00001', name: 'Lab X' });
    const { applied } = merge(base, mine, theirs, 'theirs');
    expect(applied.dataset.config.locations).toEqual([{ id: 'their00001', name: 'Lab X' }]);
  });

  it('teachers and classes are folded inside their id lists; a subject takes the team\'s colour', () => {
    const base = emptyDataset();
    let mine = addEntity(base, 'teacher', { id: 'mT', name: 'Dana' });
    mine = addEntity(mine, 'class', { id: 'mC', name: 'Class 1' });
    mine = addEntity(mine, 'subject', { id: 'mS', name: 'Lab', color: '#DC2626' });
    mine = upsertEvent(mine, WEEK, ev('m', 0, { teacherIds: ['mT'], classIds: ['mC'], subjectId: 'mS' }));
    let theirs = addEntity(base, 'teacher', { id: 'tT', name: 'Dana' });
    theirs = addEntity(theirs, 'class', { id: 'tC', name: 'Class 1' });
    theirs = addEntity(theirs, 'subject', { id: 'tS', name: 'Lab', color: '#16A34A' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(applied.dataset, WEEK, 'm')).toMatchObject({ teacherIds: ['tT'], classIds: ['tC'], subjectId: 'tS' });
    expect(applied.dataset.config.subjects).toEqual([{ id: 'tS', name: 'Lab', color: '#16A34A' }]);
    expect(applied.notes.map((note) => note.code)).toEqual(['entity-merged', 'entity-merged', 'entity-merged']);
  });

  it('a version of mine that is kept aside points to the team\'s entry as well', () => {
    let base = emptyDataset();
    base = upsertEvent(base, WEEK, ev('shared', 0, { title: 'Base' }));
    const mine = upsertEvent(addEntity(base, 'location', { id: 'mine000001', name: 'Room 101' }), WEEK, ev('shared', 0, { title: 'Mine', locationId: 'mine000001' }));
    const theirs = upsertEvent(addEntity(base, 'location', { id: 'their00001', name: 'Room 101' }), WEEK, ev('shared', 0, { title: 'Theirs' }));
    const { applied } = merge(base, mine, theirs, 'aside');

    expect(applied.dataset.config.locations).toEqual([{ id: 'their00001', name: 'Room 101' }]);
    expect(applied.aside).toHaveLength(1);
    expect(applied.aside[0].mine).toMatchObject({ title: 'Mine', locationId: 'their00001' });
    expect(applied.aside[0].entities).toEqual([{ kind: 'location', value: { id: 'their00001', name: 'Room 101' } }]);
    // Using it later brings no second "Room 101" back.
    const after = applyAsideItem(applied.dataset, applied.aside[0]);
    expect(after.config.locations).toEqual([{ id: 'their00001', name: 'Room 101' }]);
    expect(dangling(after)).toEqual([]);
  });

  it('entries with different names stay apart, and the team\'s own list is never touched', () => {
    const base = emptyDataset();
    const mine = addEntity(base, 'location', { id: 'mine000001', name: 'Room 102' });
    let theirs = addEntity(base, 'location', { id: 'their00001', name: 'Room 101' });
    // The team itself has the same name twice (two old entries): not this merge's business.
    theirs = { ...theirs, config: { ...theirs.config, locations: [...theirs.config.locations, { id: 'their00002', name: 'Room 101' }] } };
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(applied.dataset.config.locations.map((location) => location.id)).toEqual(['their00001', 'their00002', 'mine000001']);
    expect(applied.notes).toEqual([]);
  });
});

describe('course dates that do not fit together', () => {
  it('my new start and the team\'s new end would turn the course around: the team\'s dates are kept, with a note', () => {
    const base = updateCourse(emptyDataset(), { startDate: '2026-09-06', endDate: '2027-06-30' });
    const mine = updateCourse(base, { startDate: '2027-01-10' });
    const theirs = updateCourse(base, { endDate: '2026-12-31' });
    const { result, applied } = merge(base, mine, theirs, 'theirs');

    expect(result.conflictCount).toBe(0);
    expect(applied.dataset.config.course).toMatchObject({ startDate: '2026-09-06', endDate: '2026-12-31' });
    expect(applied.notes).toEqual([{ code: 'course-dates-reset' }]);
  });

  it('dates that fit are combined as before, without a note', () => {
    const base = updateCourse(emptyDataset(), { startDate: '2026-09-06', endDate: '2027-06-30' });
    const mine = updateCourse(base, { startDate: '2026-10-04' });
    const theirs = updateCourse(base, { endDate: '2026-12-31' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(applied.dataset.config.course).toMatchObject({ startDate: '2026-10-04', endDate: '2026-12-31' });
    expect(applied.notes).toEqual([]);
  });

  it('the editor itself never stores a course that ends before it starts (the name may still change)', () => {
    const dataset = updateCourse(emptyDataset(), { name: 'DevOps', startDate: '2026-09-06', endDate: '2026-12-31' });
    expect(updateCourse(dataset, { endDate: '2026-08-01' })).toBe(dataset);
    expect(updateCourse(dataset, { startDate: '2027-01-10' })).toBe(dataset);
    expect(updateCourse(dataset, { name: 'DevOps 2', startDate: '2027-01-10' }).config.course).toEqual({
      name: 'DevOps 2',
      startDate: '2026-09-06',
      endDate: '2026-12-31',
    });
    // Both at once, to a pair that fits, is taken.
    expect(updateCourse(dataset, { startDate: '2027-01-10', endDate: '2027-06-30' }).config.course).toMatchObject({
      startDate: '2027-01-10',
      endDate: '2027-06-30',
    });
    // The same day is a (one-day) course, and a missing date never contradicts anything.
    expect(updateCourse(dataset, { endDate: '2026-09-06' }).config.course.endDate).toBe('2026-09-06');
    expect(updateCourse(dataset, { endDate: null, startDate: '2030-01-01' }).config.course.startDate).toBe('2030-01-01');
  });
});

describe('whatever a merge produces can be written and read back', () => {
  it('the result of a merge with a restored entry survives the files unchanged', () => {
    const base = baseWithTeacher();
    const mine = upsertEvent(base, WEEK, ev('n1', 6, { teacherIds: ['U'] }));
    const theirs = removeEntity(base, 'teacher', 'U');
    const { applied } = merge(base, mine, theirs, 'theirs');
    const back = filesToDataset(datasetToFiles(applied.dataset));

    expect(back.problems).toEqual([]);
    expect(back.dataset).toEqual(applied.dataset);
    expect(applied.notes).toEqual([{ code: 'entity-restored', kind: 'teacher', id: 'U', name: 'Uri' }]);
  });
});

// The cases below were found by the review of the first round of fixes (pull request #1).

describe('references that the deletion itself did not remove are left alone', () => {
  it('a lesson that the DELETING side had given to somebody else before deleting her is not handed back', () => {
    const base = baseWithTeacher();
    // I move e0 from Dana to Uri, then delete Dana (which takes her off e1 … e4).
    let mine = upsertEvent(base, WEEK, ev('e0', 0, { teacherIds: ['U'] }));
    mine = removeEntity(mine, 'teacher', 'T');
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['U']);
    // The four lessons she lost only through the deletion are hers again.
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(4);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it('an event to which the deleting side added somebody in the same field is not touched either', () => {
    const base = baseWithTeacher();
    // I add Uri to e1 and then delete Dana: e1 goes from [T] to [U], which is more than the removal.
    let mine = upsertEvent(base, WEEK, ev('e1', 1, { teacherIds: ['T', 'U'] }));
    mine = removeEntity(mine, 'teacher', 'T');
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(applied.dataset, WEEK, 'e1')?.teacherIds).toEqual(['U']);
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(4);
  });
});

describe('an event of mine that is kept aside while the entry I deleted stays', () => {
  it('comes back with that entry still on it, exactly as when "mine" is chosen in the merge', () => {
    const base = baseWithTeacher();
    // I delete Dana (taking her off e0 … e4) and retitle e0; the team renames Dana and retitles e0 too.
    const mine = upsertEvent(removeEntity(base, 'teacher', 'T'), WEEK, ev('e0', 0, { teacherIds: [], title: 'My title' }));
    const theirs = upsertEvent(updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' }), WEEK, ev('e0', 0, { teacherIds: ['T'], title: 'Their title' }));
    const key = `event:${WEEK}:e0`;

    const direct = merge(base, mine, theirs, 'theirs', { [key]: 'mine' });
    expect(findEvent(direct.applied.dataset, WEEK, 'e0')).toMatchObject({ title: 'My title', teacherIds: ['T'] });

    const { applied } = merge(base, mine, theirs, 'aside');
    const item = applied.aside.find((kept) => kept.key === key);
    if (!item) throw new Error('the event was not kept aside');
    expect(item.mine).toMatchObject({ title: 'My title', teacherIds: ['T'] });
    expect(item.entities).toEqual([{ kind: 'teacher', value: { id: 'T', name: 'Dana Levi' } }]);
    const after = applyAsideItem(applied.dataset, item);
    expect(findEvent(after, WEEK, 'e0')).toEqual(findEvent(direct.applied.dataset, WEEK, 'e0'));
    expect(findEntity(after.config, 'teacher', 'T')).toEqual({ id: 'T', name: 'Dana Levi' });
  });
});

describe('an aside file that was damaged by hand', () => {
  function asideEvent(): { dataset: Dataset; item: AsideItem } {
    const base = baseWithTeacher();
    const theirs = removeEntity(base, 'teacher', 'T');
    const mine = upsertEvent(base, WEEK, ev('e0', 0, { teacherIds: ['T', 'U'], title: 'Mine' }));
    const { applied } = merge(base, mine, theirs, 'aside');
    return { dataset: applied.dataset, item: applied.aside[0] };
  }

  it.each([
    ['a text', 'oops'],
    ['an object', { 0: { kind: 'teacher', value: { id: 'T', name: 'Dana' } } }],
    ['a list with a null in it', [null]],
    ['a list with a number in it', [7]],
    ['an entry of another kind', [{ kind: 'class', value: { id: 'T', name: 'Dana' } }]],
    ['an entry without a name', [{ kind: 'teacher', value: { id: 'T' } }]],
    ['a subject without a colour', [{ kind: 'subject', value: { id: 'T', name: 'Dana' } }]],
  ])('"entities" is %s: the event comes back without what cannot be restored, and nothing is thrown', (_what, entities) => {
    const { dataset, item } = asideEvent();
    // What JSON.parse of the aside file hands back; only `key` is checked when the file is read.
    const damaged = JSON.parse(JSON.stringify({ ...item, entities })) as AsideItem;
    const after = applyAsideItem(dataset, damaged);

    expect(findEvent(after, WEEK, 'e0')).toMatchObject({ title: 'Mine', teacherIds: ['U'] });
    expect(findEntity(after.config, 'teacher', 'T')).toBeUndefined();
    expect(dangling(after)).toEqual([]);
  });
});

describe('the same name twice, when one side renamed an entry both sides have', () => {
  it('I rename a room to the name of a room the team has just added: the team\'s new entry is folded into the renamed one', () => {
    let base = addEntity(emptyDataset(), 'location', { id: 'old0000001', name: 'Room 1' });
    base = upsertEvent(base, WEEK, ev('shared', 0, { locationId: 'old0000001' }));
    const mine = updateEntity(base, 'location', 'old0000001', { name: 'Room 101' });
    const theirs = upsertEvent(addEntity(base, 'location', { id: 'their00001', name: 'Room 101' }), WEEK, ev('new', 1, { locationId: 'their00001' }));
    const { result, applied } = merge(base, mine, theirs, 'theirs');

    expect(result.conflictCount).toBe(0);
    expect(applied.dataset.config.locations).toEqual([{ id: 'old0000001', name: 'Room 101' }]);
    expect(findEvent(applied.dataset, WEEK, 'shared')?.locationId).toBe('old0000001');
    expect(findEvent(applied.dataset, WEEK, 'new')?.locationId).toBe('old0000001');
    expect(applied.notes).toEqual([{ code: 'entity-merged', kind: 'location', id: 'old0000001', name: 'Room 101' }]);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it('the mirror: the team renames, I add; my new entry is folded into the renamed one', () => {
    const base = addEntity(emptyDataset(), 'location', { id: 'old0000001', name: 'Room 1' });
    const theirs = updateEntity(base, 'location', 'old0000001', { name: 'Room 101' });
    const mine = upsertEvent(addEntity(base, 'location', { id: 'mine000001', name: 'Room 101' }), WEEK, ev('m', 0, { locationId: 'mine000001' }));
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(applied.dataset.config.locations).toEqual([{ id: 'old0000001', name: 'Room 101' }]);
    expect(findEvent(applied.dataset, WEEK, 'm')?.locationId).toBe('old0000001');
  });

  it('two rooms that both sides have and that were renamed to the same name are different rooms: both stay, and a note says so', () => {
    let base = addEntity(emptyDataset(), 'location', { id: 'a000000001', name: 'Room A' });
    base = addEntity(base, 'location', { id: 'b000000001', name: 'Room B' });
    const mine = updateEntity(base, 'location', 'a000000001', { name: 'Lab' });
    const theirs = updateEntity(base, 'location', 'b000000001', { name: 'lab' });
    const { result, applied } = merge(base, mine, theirs, 'theirs');

    expect(result.conflictCount).toBe(0);
    expect(applied.dataset.config.locations.map((location) => location.id)).toEqual(['a000000001', 'b000000001']);
    expect(applied.notes).toEqual([{ code: 'entity-duplicate', kind: 'location', name: 'Lab' }]);
  });

  it('a second merge of the folded result against the same team version changes nothing', () => {
    const base = addEntity(emptyDataset(), 'location', { id: 'old0000001', name: 'Room 1' });
    const mine = updateEntity(base, 'location', 'old0000001', { name: 'Room 101' });
    const theirs = addEntity(base, 'location', { id: 'their00001', name: 'Room 101' });
    const first = merge(base, mine, theirs, 'theirs').applied.dataset;
    const second = merge(theirs, first, theirs, 'theirs');

    expect(second.result.conflictCount).toBe(0);
    expect(second.applied.dataset).toEqual(first);
    expect(second.applied.notes).toEqual([]);
  });
});

// The cases below were found by the second review of pull request #1: the rule above looked
// at ONE deleted entry at a time, so it failed as soon as the deleting side had deleted two.

describe('the deleting side deleted several entries that share a lesson, and one of them stays', () => {
  /** Dana (T) and Vered (V) teach five lessons together; Uri (U) is in the list too. */
  function baseTwoTeachers(): Dataset {
    let dataset = emptyDataset();
    dataset = addEntity(dataset, 'teacher', { id: 'T', name: 'Dana' });
    dataset = addEntity(dataset, 'teacher', { id: 'U', name: 'Uri' });
    dataset = addEntity(dataset, 'teacher', { id: 'V', name: 'Vered' });
    for (let i = 0; i < 5; i++) dataset = upsertEvent(dataset, WEEK, ev(`e${i}`, i, { teacherIds: ['T', 'V'] }));
    return dataset;
  }
  const deleteBoth = (dataset: Dataset): Dataset => removeEntity(removeEntity(dataset, 'teacher', 'T'), 'teacher', 'V');

  it('I delete Dana and Vered, the team renames Dana and its version is kept: Dana keeps her five lessons, Vered is gone', () => {
    const base = baseTwoTeachers();
    const mine = deleteBoth(base);
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { result, applied } = merge(base, mine, theirs, 'theirs');

    expect(result.items.filter((item) => item.status === 'conflict').map((item) => item.key)).toEqual(['teacher:T']);
    expect(findEntity(applied.dataset.config, 'teacher', 'T')).toEqual({ id: 'T', name: 'Dana Levi' });
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(5);
    // My other deletion did happen: Vered is off the list and off every lesson.
    expect(findEntity(applied.dataset.config, 'teacher', 'V')).toBeUndefined();
    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['T']);
    expect(applied.notes).toEqual([]);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it('I delete both, the team renames both, both are kept aside: both keep their lessons and nothing is left for me to publish', () => {
    const base = baseTwoTeachers();
    const mine = deleteBoth(base);
    const theirs = updateEntity(updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' }), 'teacher', 'V', { name: 'Vered Cohen' });
    const { applied } = merge(base, mine, theirs, 'aside');

    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(5);
    expect(countEntityUsage(applied.dataset, 'teacher', 'V')).toBe(5);
    expect(applied.aside.map((item) => item.key)).toEqual(['teacher:T', 'teacher:V']);
    expect(applied.dataset).toEqual(theirs);
  });

  it('the mirror: the team deletes both, I rename Dana and my version wins', () => {
    const base = baseTwoTeachers();
    const theirs = deleteBoth(base);
    const mine = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'mine');

    expect(findEntity(applied.dataset.config, 'teacher', 'T')).toEqual({ id: 'T', name: 'Dana Levi' });
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(5);
    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['T']);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it('the same for classes', () => {
    let base = emptyDataset();
    base = addEntity(base, 'class', { id: 'A', name: 'Class A' });
    base = addEntity(base, 'class', { id: 'B', name: 'Class B' });
    for (let i = 0; i < 3; i++) base = upsertEvent(base, WEEK, ev(`e${i}`, i, { classIds: ['A', 'B'] }));
    const mine = removeEntity(removeEntity(base, 'class', 'A'), 'class', 'B');
    const theirs = updateEntity(base, 'class', 'A', { name: 'Class A1' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(countEntityUsage(applied.dataset, 'class', 'A')).toBe(3);
    expect(findEvent(applied.dataset, WEEK, 'e0')?.classIds).toEqual(['A']);
  });

  it('my version of a lesson that is kept aside comes back with the teacher who stays', () => {
    const base = baseTwoTeachers();
    // I delete both and retitle e0; the team renames Dana and retitles e0 too.
    const mine = upsertEvent(deleteBoth(base), WEEK, ev('e0', 0, { teacherIds: [], title: 'My title' }));
    const theirs = upsertEvent(updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' }), WEEK, ev('e0', 0, { teacherIds: ['T', 'V'], title: 'Their title' }));
    const { applied } = merge(base, mine, theirs, 'aside');
    const item = applied.aside.find((kept) => kept.key === `event:${WEEK}:e0`);
    if (!item) throw new Error('the event was not kept aside');

    expect(item.mine).toMatchObject({ title: 'My title', teacherIds: ['T'] });
    const after = applyAsideItem(applied.dataset, item);
    expect(findEvent(after, WEEK, 'e0')).toMatchObject({ title: 'My title', teacherIds: ['T'] });
    expect(dangling(after)).toEqual([]);
  });

  it('a lesson from which the deleting side ALSO took somebody who still exists was changed on purpose: it is left as that side made it', () => {
    let base = baseTwoTeachers();
    base = upsertEvent(base, WEEK, ev('e0', 0, { teacherIds: ['T', 'U', 'V'] }));
    // I take Uri off e0 (he stays in the list), then delete Dana and Vered.
    const mine = deleteBoth(upsertEvent(base, WEEK, ev('e0', 0, { teacherIds: ['T', 'V'] })));
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(mine, WEEK, 'e0')?.teacherIds).toEqual([]);
    // e0 was edited by hand in that field, so nothing is guessed there …
    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual([]);
    // … while the four lessons that lost Dana only through the deletion have her back.
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(4);
    expect(dangling(applied.dataset)).toEqual([]);
  });

  it('a lesson on which a deleted and an untouched teacher stood together keeps the untouched one and gets the kept one back', () => {
    let base = baseTwoTeachers();
    base = upsertEvent(base, WEEK, ev('e0', 0, { teacherIds: ['T', 'U', 'V'] }));
    const mine = deleteBoth(base);
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['T', 'U']);
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(5);
  });
});

// Found by the third review of pull request #1: the rule for several deletions compared with
// "what the deleting side's lists still have", and so stumbled over a name that no list has.

describe('a lesson that also names an entry which is in no list (a file edited by hand, or left by an old version)', () => {
  /** Dana (T) teaches three lessons that also name "G", an id no list knows. Vered (V) is in the list. */
  function baseWithStray(teacherIds: string[] = ['G', 'T']): Dataset {
    let dataset = emptyDataset();
    dataset = addEntity(dataset, 'teacher', { id: 'T', name: 'Dana' });
    dataset = addEntity(dataset, 'teacher', { id: 'V', name: 'Vered' });
    for (let i = 0; i < 3; i++) dataset = upsertEvent(dataset, WEEK, ev(`e${i}`, i, { teacherIds }));
    return dataset;
  }

  it('such a schedule can be written and read back as it is', () => {
    const base = baseWithStray();
    const back = filesToDataset(datasetToFiles(base));
    expect(back.problems).toEqual([]);
    expect(findEvent(back.dataset, WEEK, 'e0')?.teacherIds).toEqual(['G', 'T']);
  });

  it('I delete Dana, the team renames her and its version is kept: she keeps her three lessons, the stray name is left alone', () => {
    const base = baseWithStray();
    const mine = removeEntity(base, 'teacher', 'T');
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(mine, WEEK, 'e0')?.teacherIds).toEqual(['G']);
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(3);
    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['G', 'T']);
    // Nothing of this is left for me to publish.
    expect(applied.dataset).toEqual(theirs);
  });

  it('the mirror: the team deletes her, I rename her and my version wins', () => {
    const base = baseWithStray();
    const theirs = removeEntity(base, 'teacher', 'T');
    const mine = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'mine');

    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(3);
    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['G', 'T']);
  });

  it('together with a second deletion: Dana comes back, Vered stays deleted, the stray name stays', () => {
    const base = baseWithStray(['G', 'T', 'V']);
    const mine = removeEntity(removeEntity(base, 'teacher', 'T'), 'teacher', 'V');
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['G', 'T']);
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(3);
    expect(findEntity(applied.dataset.config, 'teacher', 'V')).toBeUndefined();
  });

  it('a stray name the deleting side took off by hand stays off; Dana still comes back', () => {
    const base = baseWithStray();
    // I clear the teachers of e0 by hand (which drops the stray name), then delete Dana.
    const mine = removeEntity(upsertEvent(base, WEEK, ev('e0', 0, { teacherIds: ['T'] })), 'teacher', 'T');
    const theirs = updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' });
    const { applied } = merge(base, mine, theirs, 'theirs');

    expect(findEvent(mine, WEEK, 'e0')?.teacherIds).toEqual([]);
    expect(findEvent(applied.dataset, WEEK, 'e0')?.teacherIds).toEqual(['T']);
    expect(findEvent(applied.dataset, WEEK, 'e1')?.teacherIds).toEqual(['G', 'T']);
    expect(countEntityUsage(applied.dataset, 'teacher', 'T')).toBe(3);
  });

  it('a kept-aside lesson of mine gets Dana back as well, next to the stray name', () => {
    const base = baseWithStray();
    const mine = upsertEvent(removeEntity(base, 'teacher', 'T'), WEEK, ev('e0', 0, { teacherIds: ['G'], title: 'My title' }));
    const theirs = upsertEvent(updateEntity(base, 'teacher', 'T', { name: 'Dana Levi' }), WEEK, ev('e0', 0, { teacherIds: ['G', 'T'], title: 'Their title' }));
    const { applied } = merge(base, mine, theirs, 'aside');
    const item = applied.aside.find((kept) => kept.key === `event:${WEEK}:e0`);
    if (!item) throw new Error('the event was not kept aside');

    expect(item.mine).toMatchObject({ title: 'My title', teacherIds: ['G', 'T'] });
  });
});
