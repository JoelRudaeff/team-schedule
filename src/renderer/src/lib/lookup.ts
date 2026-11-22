/** Small helpers for showing events and list entries. */
import { NEUTRAL_EVENT_COLOR } from '@shared/colors';
import { findEntity, findSubject } from '@shared/model';
import type { EntityKind, ScheduleConfig, ScheduleEvent } from '@shared/types';

/** Name of a list entry, `fallback` when the id is null or the entry was deleted. */
export function entityName(config: ScheduleConfig, kind: EntityKind, id: string | null, fallback = ''): string {
  if (!id) return fallback;
  return findEntity(config, kind, id)?.name ?? fallback;
}

/** Names for a list of ids, in the order of the configured list; deleted entries are skipped. */
export function entityNames(config: ScheduleConfig, kind: EntityKind, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const key = kind === 'subject' ? 'subjects' : kind === 'location' ? 'locations' : kind === 'teacher' ? 'teachers' : 'classes';
  return config[key].filter((item) => wanted.has(item.id)).map((item) => item.name);
}

/** The event's colour: its subject's colour, or a neutral grey. */
export function eventColor(event: ScheduleEvent, config: ScheduleConfig): string {
  return findSubject(config, event.subjectId)?.color ?? NEUTRAL_EVENT_COLOR;
}

/** What to show as the event's headline: its title, else its subject name, else `untitled`. */
export function eventHeadline(event: ScheduleEvent, config: ScheduleConfig, untitled: string): string {
  if (event.title.trim() !== '') return event.title;
  return findSubject(config, event.subjectId)?.name ?? untitled;
}
