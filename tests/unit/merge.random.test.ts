/**
 * Random three-way merges. Two sides start from the same schedule and each does a handful of
 * the things the editor allows (add, rename and delete list entries; add, edit and delete
 * lessons); every collision is settled at random as "mine", "theirs" or "keep aside".
 * Whatever comes out must keep the promises that single hand-written cases cannot cover in
 * all their combinations:
 *
 *  - nothing is thrown;
 *  - no lesson points at a list entry that does not exist;
 *  - no lesson gains a list entry that neither side had put on it;
 *  - a list entry that one side deleted and that stays after all keeps the lessons it lost
 *    only through that deletion;
 *  - no name is left in a list twice without a note;
 *  - merging the result with the same team version again changes nothing;
 *  - every version that was kept aside can be used without leaving a lesson pointing at nothing.
 *
 * The seeds are fixed, so a failure names a case that can be run again. (The second review of
 * pull request #1 used this method to find that a kept teacher lost her lessons when the
 * other side had deleted two entries sharing them; that is the fourth promise.)
 */
import { describe, expect, it } from 'vitest';
import { applyAsideItem, applyMerge, mergeDatasets, type Resolution } from '@shared/merge';
import {
  addEntity,
  entityList,
  findEntity,
  findEntityByName,
  findEvent,
  nameKey,
  referencedIds,
  removeEntity,
  removeEvent,
  updateEntity,
  upsertEvent,
} from '@shared/model';
import { emptyDataset } from '@shared/serialize';
import type { Dataset, EntityKind, ScheduleEvent } from '@shared/types';

const WEEK = '2026-11-22';
const NOW = '2026-11-22T00:00:00.000Z';
const KINDS: EntityKind[] = ['subject', 'location', 'teacher', 'class'];
const LIST_KEYS = ['subjects', 'locations', 'teachers', 'classes'] as const;
/** Few names, so that both sides often pick the same one. */
const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Eps'];
const SEEDS = 3000;

/** A small seeded generator (mulberry32): the same seed always gives the same merge. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `steps` random edits of the kind the editor makes, by the side called `side`. */
function edit(start: Dataset, random: () => number, side: string, steps: number): Dataset {
  let dataset = start;
  let counter = 0;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const ids = (kind: EntityKind): string[] => entityList(dataset.config, kind).map((entry) => entry.id);
  const some = (kind: EntityKind): string[] => ids(kind).filter(() => random() < 0.5).sort();
  const one = (kind: EntityKind): string | null => (ids(kind).length > 0 && random() < 0.5 ? pick(ids(kind)) : null);

  for (let step = 0; step < steps; step++) {
    const kind = pick(KINDS);
    const list = entityList(dataset.config, kind);
    const events = dataset.weeks[WEEK]?.events ?? [];
    const roll = random();
    if (roll < 0.15) {
      const name = pick(NAMES);
      if (!findEntityByName(dataset.config, kind, name)) {
        const id = `${side}${kind[0]}${counter++}`;
        dataset = addEntity(dataset, kind, kind === 'subject' ? { id, name, color: '#112233' } : { id, name });
      }
    } else if (roll < 0.35 && list.length > 0) {
      const name = pick(NAMES);
      if (!findEntityByName(dataset.config, kind, name)) dataset = updateEntity(dataset, kind, pick(list).id, { name });
    } else if (roll < 0.55 && list.length > 0) {
      dataset = removeEntity(dataset, kind, pick(list).id);
    } else if (roll < 0.7) {
      dataset = upsertEvent(dataset, WEEK, {
        id: `${side}e${counter++}`,
        day: Math.floor(random() * 5) as ScheduleEvent['day'],
        start: 540,
        end: 600,
        title: `${side}${step}`,
        subjectId: one('subject'),
        locationId: one('location'),
        teacherIds: some('teacher'),
        classIds: some('class'),
        notes: '',
      });
    } else if (roll < 0.92 && events.length > 0) {
      const event = pick(events);
      const what = random();
      let next: ScheduleEvent;
      if (what < 0.25) next = { ...event, title: `${side}t${step}` };
      else if (what < 0.5) next = { ...event, teacherIds: some('teacher') };
      else if (what < 0.7) next = { ...event, classIds: some('class') };
      else if (what < 0.85) next = { ...event, locationId: ids('location').length > 0 ? pick(ids('location')) : null };
      else next = { ...event, subjectId: ids('subject').length > 0 ? pick(ids('subject')) : null };
      dataset = upsertEvent(dataset, WEEK, next);
    } else if (events.length > 0) {
      dataset = removeEvent(dataset, WEEK, pick(events).id);
    }
  }
  return dataset;
}

/** Every reference of every lesson that points at an entry the lists do not have. */
function dangling(dataset: Dataset): string[] {
  const found: string[] = [];
  for (const week of Object.values(dataset.weeks)) {
    for (const event of week.events) {
      for (const kind of KINDS) {
        for (const id of referencedIds(event, kind)) {
          if (!findEntity(dataset.config, kind, id)) found.push(`${event.id} -> ${kind} ${id}`);
        }
      }
    }
  }
  return found;
}

function hasNameTwice(dataset: Dataset): boolean {
  return KINDS.some((kind) => {
    const keys = entityList(dataset.config, kind).map((entry) => nameKey(entry.name));
    return new Set(keys).size !== keys.length;
  });
}

/** The dataset as text with the lists in id order (the order of a list is not what is checked here). */
function canonical(dataset: Dataset): string {
  const config: Record<string, unknown> = { ...dataset.config };
  for (const key of LIST_KEYS) config[key] = [...dataset.config[key]].sort((a, b) => (a.id < b.id ? -1 : 1));
  return JSON.stringify({ config, weeks: dataset.weeks });
}

/** Runs one random merge and returns what it broke (an empty list when all promises hold). */
function brokenPromises(seed: number): string[] | null {
  const random = generator(seed);
  const base = edit(emptyDataset(), random, 'b', 25);
  const mine = edit(base, random, 'm', 8);
  const theirs = edit(base, random, 't', 8);
  // The editor never lets one user give two entries the same name.
  if (hasNameTwice(mine) || hasNameTwice(theirs)) return null;

  const result = mergeDatasets(base, mine, theirs);
  const resolutions: Record<string, Resolution> = {};
  for (const item of result.items) {
    if (item.status === 'conflict') resolutions[item.key] = (['mine', 'theirs', 'aside'] as const)[Math.floor(random() * 3)];
  }
  const broken: string[] = [];
  try {
    const applied = applyMerge({ mine, theirs, result, resolutions, defaultResolution: 'theirs', now: NOW });
    const events = applied.dataset.weeks[WEEK]?.events ?? [];

    for (const text of dangling(applied.dataset)) broken.push(`points at nothing: ${text}`);

    // Entries that took over the lessons of a folded twin may appear on lessons that never named them.
    const tookOver = new Set(applied.notes.flatMap((note) => (note.code === 'entity-merged' ? [`${note.kind}:${note.id}`] : [])));
    for (const event of events) {
      const my = findEvent(mine, WEEK, event.id);
      const their = findEvent(theirs, WEEK, event.id);
      for (const kind of KINDS) {
        for (const id of referencedIds(event, kind)) {
          const known = (my && referencedIds(my, kind).includes(id)) || (their && referencedIds(their, kind).includes(id));
          if (!known && !tookOver.has(`${kind}:${id}`)) broken.push(`gained from nowhere: ${event.id} ${kind} ${id}`);
        }
      }
    }

    for (const event of events) {
      const baseEvent = findEvent(base, WEEK, event.id);
      if (!baseEvent) continue;
      for (const [deleter, keeper] of [
        [mine, theirs],
        [theirs, mine],
      ] as const) {
        const deleted = findEvent(deleter, WEEK, event.id);
        const kept = findEvent(keeper, WEEK, event.id);
        if (!deleted || !kept) continue;
        for (const kind of KINDS) {
          const before = referencedIds(baseEvent, kind);
          const after = referencedIds(deleted, kind);
          const gone = before.filter((id) => !after.includes(id));
          // That side took nothing off this lesson but entries it deleted, and added nothing.
          const onlyDeletions =
            gone.length > 0 && gone.every((id) => !findEntity(deleter.config, kind, id)) && after.every((id) => before.includes(id));
          if (!onlyDeletions) continue;
          for (const id of gone) {
            const collision = result.items.find((item) => item.kind === kind && item.id === id && item.status === 'conflict');
            if (!collision) continue;
            const settledForKeeping = deleter === mine ? resolutions[collision.key] !== 'mine' : resolutions[collision.key] === 'mine';
            const stays = settledForKeeping && findEntity(applied.dataset.config, kind, id) && findEntity(keeper.config, kind, id);
            if (stays && referencedIds(kept, kind).includes(id) && !referencedIds(event, kind).includes(id)) {
              broken.push(`lost through a deletion that did not happen: ${event.id} ${kind} ${id}`);
            }
          }
        }
      }
    }

    for (const kind of KINDS) {
      const teamKeys = entityList(theirs.config, kind).map((entry) => nameKey(entry.name));
      const keys = entityList(applied.dataset.config, kind).map((entry) => nameKey(entry.name));
      for (const key of new Set(keys)) {
        if (keys.filter((other) => other === key).length < 2 || teamKeys.filter((other) => other === key).length > 1) continue;
        const said = applied.notes.some((note) => note.code === 'entity-duplicate' && note.kind === kind && nameKey(note.name) === key);
        if (!said) broken.push(`the same name twice without a note: ${kind} "${key}"`);
      }
    }

    const second = mergeDatasets(theirs, applied.dataset, theirs);
    const again = applyMerge({ mine: applied.dataset, theirs, result: second, resolutions: {}, defaultResolution: 'theirs', now: NOW });
    if (second.conflictCount !== 0) broken.push(`a second merge collides: ${second.conflictCount}`);
    if (canonical(again.dataset) !== canonical(applied.dataset)) broken.push('a second merge changes the result');

    for (const item of applied.aside) {
      for (const text of dangling(applyAsideItem(applied.dataset, item))) broken.push(`after using ${item.key}: ${text}`);
    }
  } catch (error) {
    broken.push(`threw: ${String(error)}`);
  }
  return broken;
}

describe('random merges keep every promise', () => {
  it(`${SEEDS} seeded merges: nothing thrown, nothing dangling, nothing gained or lost by accident, stable, aside usable`, () => {
    const failures: string[] = [];
    let ran = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const broken = brokenPromises(seed);
      if (broken === null) continue;
      ran += 1;
      for (const text of broken) failures.push(`seed ${seed}: ${text}`);
    }
    // Most seeds must give a usable case, or the test checks far less than its name says.
    expect(ran).toBeGreaterThan(SEEDS / 2);
    expect(failures.slice(0, 20)).toEqual([]);
  });
});
