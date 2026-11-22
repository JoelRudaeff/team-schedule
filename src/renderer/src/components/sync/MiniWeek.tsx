import { useMemo, type ReactNode } from 'react';
import type { MergeItem } from '@shared/merge';
import type { DayIndex, IsoDate, ScheduleConfig, ScheduleEvent } from '@shared/types';
import { useT } from '../../i18n/useT';
import { eventLine, isEvent } from '../../lib/describe';
import { dayName, formatWeekRange } from '../../lib/format';
import { eventHeadline } from '../../lib/lookup';
import { layoutDay } from '../grid/layout';

const DAYS: readonly DayIndex[] = [0, 1, 2, 3, 4, 5, 6];
const COLUMN_HEIGHT = 132;

type Tone = 'theirs' | 'mine' | 'both' | 'conflict-mine' | 'conflict-theirs' | 'same' | 'context';

interface Block {
  id: string;
  event: ScheduleEvent;
  tone: Tone;
  /** The event is gone in this version (drawn hatched, where it used to be). */
  removed: boolean;
  /** Conflict key, so a click can jump to its decision card. */
  conflictKey?: string;
}

function blocksOf(items: readonly MergeItem[], context: readonly ScheduleEvent[]): Block[] {
  const blocks: Block[] = context.map((event) => ({ id: `ctx:${event.id}`, event, tone: 'context', removed: false }));
  const add = (id: string, value: MergeItem['mine'], fallback: MergeItem['base'], tone: Tone, conflictKey?: string): void => {
    const event = isEvent(value) ? value : isEvent(fallback) ? fallback : null;
    if (event) blocks.push({ id, event, tone, removed: !isEvent(value), conflictKey });
  };
  for (const item of items) {
    if (item.status === 'conflict') {
      add(`mine:${item.key}`, item.mine, item.base, 'conflict-mine', item.key);
      add(`theirs:${item.key}`, item.theirs, item.base, 'conflict-theirs', item.key);
    } else if (item.status === 'theirs') add(item.key, item.theirs, item.base, 'theirs');
    else if (item.status === 'mine') add(item.key, item.mine, item.base, 'mine');
    else if (item.status === 'combined') add(item.key, item.merged, item.base, 'both');
    else add(item.key, item.mine, item.base, 'same');
  }
  return blocks;
}

interface MiniWeekProps {
  weekStart: IsoDate;
  /** The event items of this week from the merge result. */
  items: readonly MergeItem[];
  /** Events of this week that nobody changed (drawn faintly, for orientation). */
  context: readonly ScheduleEvent[];
  config: ScheduleConfig;
  onPickConflict: (key: string) => void;
}

/** A small picture of one week: who changed what, and where the collisions are. */
export function MiniWeek({ weekStart, items, context, config, onPickConflict }: MiniWeekProps): ReactNode {
  const tr = useT();
  const { t, lang } = tr;
  const blocks = useMemo(() => blocksOf(items, context), [items, context]);

  const from = Math.floor(Math.min(...blocks.map((b) => b.event.start), 480) / 60) * 60;
  const to = Math.max(Math.ceil(Math.max(...blocks.map((b) => b.event.end), 960) / 60) * 60, from + 120);
  const scale = COLUMN_HEIGHT / (to - from);

  const toneLabel: Record<Tone, string> = {
    theirs: t('sync.legendTeam'),
    mine: t('sync.legendMine'),
    both: `${t('sync.legendTeam')} + ${t('sync.legendMine')}`,
    'conflict-mine': `${t('sync.legendConflict')} · ${t('sync.yours')}`,
    'conflict-theirs': `${t('sync.legendConflict')} · ${t('sync.teams')}`,
    same: `${t('sync.legendTeam')} = ${t('sync.legendMine')}`,
    context: t('sync.legendUnchanged'),
  };

  return (
    <div className="sy-week" data-testid={`merge-week-${weekStart}`}>
      <div className="sy-week__title">{t('sync.weekMapTitle', { range: formatWeekRange(weekStart, lang) })}</div>
      <div className="sy-week__grid">
        {DAYS.map((day) => {
          const dayBlocks = blocks.filter((block) => block.event.day === day);
          const placement = layoutDay(dayBlocks.map((block) => ({ id: block.id, start: block.event.start, end: block.event.end })));
          return (
            <div key={day} className="sy-week__day">
              <div className="sy-week__day-name">{dayName(day, lang, 'short')}</div>
              <div className="sy-week__column" style={{ height: COLUMN_HEIGHT }}>
                {dayBlocks.map((block) => {
                  const place = placement.get(block.id) ?? { column: 0, columns: 1 };
                  const title = `${toneLabel[block.tone]}${block.removed ? ` (${t('sync.legendRemoved')})` : ''}\n${eventHeadline(block.event, config, t('common.untitledEvent'))}\n${eventLine(block.event, weekStart, config, tr)}`;
                  const style = {
                    top: (block.event.start - from) * scale,
                    height: Math.max(6, (block.event.end - block.event.start) * scale - 1),
                    insetInlineStart: `${(place.column / place.columns) * 100}%`,
                    width: `calc(${100 / place.columns}% - 1px)`,
                  };
                  const className = `sy-block sy-block--${block.tone}${block.removed ? ' is-removed' : ''}`;
                  return block.conflictKey ? (
                    <button
                      key={block.id}
                      type="button"
                      className={className}
                      style={style}
                      title={title}
                      aria-label={title}
                      onClick={() => block.conflictKey && onPickConflict(block.conflictKey)}
                    />
                  ) : (
                    <div key={block.id} className={className} style={style} title={title} />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What the colours of the week maps mean. */
export function MiniWeekLegend(): ReactNode {
  const { t } = useT();
  return (
    <div className="sy-legend" aria-hidden="true">
      <span>
        <i className="sy-block sy-block--theirs" /> {t('sync.legendTeam')}
      </span>
      <span>
        <i className="sy-block sy-block--mine" /> {t('sync.legendMine')}
      </span>
      <span>
        <i className="sy-block sy-block--conflict-mine" /> {t('sync.legendConflict')}
      </span>
      <span>
        <i className="sy-block sy-block--theirs is-removed" /> {t('sync.legendRemoved')}
      </span>
      <span>
        <i className="sy-block sy-block--context" /> {t('sync.legendUnchanged')}
      </span>
    </div>
  );
}
