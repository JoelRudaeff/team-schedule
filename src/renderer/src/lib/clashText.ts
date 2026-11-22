import type { Clash } from '@shared/model';
import type { ScheduleConfig, ScheduleEvent } from '@shared/types';
import type { MessageKey, Translator } from '../i18n';
import { entityName, eventHeadline } from './lookup';

const CLASH_TEXT: Record<Clash['reason'], MessageKey> = {
  location: 'grid.clashLocation',
  teacher: 'grid.clashTeacher',
  class: 'grid.clashClass',
};

/** One sentence per double booking, e.g. `Room 1 is also used by "Lab" at this time`. */
export function describeClashes(
  clashes: readonly Clash[],
  events: readonly ScheduleEvent[],
  config: ScheduleConfig,
  t: Translator['t'],
): string[] {
  const lines = clashes.map((clash) => {
    const other = events.find((event) => event.id === clash.otherId);
    return t(CLASH_TEXT[clash.reason], {
      name: entityName(config, clash.reason, clash.sharedId, t('common.unknown')),
      other: other ? eventHeadline(other, config, t('common.untitledEvent')) : t('common.unknown'),
    });
  });
  return [...new Set(lines)];
}
