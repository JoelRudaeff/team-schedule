import { useMemo, useState, type ReactNode } from 'react';
import type { ItemValue, MergeItem, Resolution } from '@shared/merge';
import { deepEqual, getWeek } from '@shared/model';
import type { IsoDate, ScheduleConfig, ScheduleEvent } from '@shared/types';
import type { MessageKey } from '../../i18n';
import { useT } from '../../i18n/useT';
import { describeItem, fieldList, isEvent, isNamed, lookupConfig, scalarText } from '../../lib/describe';
import { eventHeadline } from '../../lib/lookup';
import { actions, useApp } from '../../store';
import type { DialogState, MergeChoice } from '../../store/types';
import { EventFacts } from '../common/EventFacts';
import { Badge, Button, Callout, Checkbox, ColorDot, Icon, Modal, RadioGroup } from '../ui';
import { ChangeList, type ChangeRow } from './ChangeList';
import { MergeGraph } from './MergeGraph';
import { MiniWeek, MiniWeekLegend } from './MiniWeek';
import './sync.css';

/** The ways to settle the whole merge at once (the last one opens the per-collision choices). */
type Option = 'push' | 'keep-mine' | 'update' | 'aside' | 'custom';

const EVENT_FIELDS = ['day', 'start', 'end', 'subjectId', 'locationId', 'teacherIds', 'classIds', 'notes'] as const;

function differingFields(a: ScheduleEvent, b: ScheduleEvent): string[] {
  return EVENT_FIELDS.filter((field) => !deepEqual(a[field], b[field]));
}

/** One side of a collision. */
function Version({
  item,
  value,
  other,
  config,
}: {
  item: MergeItem;
  value: ItemValue | undefined;
  other: ItemValue | undefined;
  config: ScheduleConfig;
}): ReactNode {
  const tr = useT();
  const { t } = tr;
  if (value === undefined) return <Badge tone="danger">{t('sync.deleted')}</Badge>;
  if (isEvent(value)) {
    return (
      <>
        <strong className="user-text">{eventHeadline(value, config, t('common.untitledEvent'))}</strong>
        <EventFacts event={value} config={config} weekStart={item.weekStart} highlight={isEvent(other) ? differingFields(value, other) : []} />
      </>
    );
  }
  if (isNamed(value)) {
    return (
      <span className="sy-version__named">
        {'color' in value && typeof value.color === 'string' ? <ColorDot color={value.color} size={12} /> : null}
        <strong className="user-text">{value.name}</strong>
      </span>
    );
  }
  return <strong className="user-text">{scalarText(item, value, tr)}</strong>;
}

interface ConflictCardProps {
  item: MergeItem;
  config: ScheduleConfig;
  resolution: Resolution;
  /** False while one of the "all at once" options is selected: the card then only shows what that option does. */
  editable: boolean;
  onResolve: (resolution: Resolution) => void;
}

function ConflictCard({ item, config, resolution, editable, onResolve }: ConflictCardProps): ReactNode {
  const tr = useT();
  const { t } = tr;
  const title = describeItem(item, item.mine ?? item.theirs ?? item.base, config, tr).title;

  let reason: string;
  if (item.mineChange === 'deleted') reason = t('sync.collisionDeleteMine');
  else if (item.theirsChange === 'deleted') reason = t('sync.collisionDeleteTheirs');
  else if (item.base === undefined) reason = t('sync.collisionBothAdded');
  else {
    const fields = fieldList(item.conflictFields, t);
    reason = fields === '' ? '' : t('sync.collisionFields', { fields });
  }

  return (
    <article className="sy-conflict" id={`conflict-${item.key}`} data-testid="conflict-card" data-key={item.key}>
      <header className="sy-conflict__head">
        <Icon name="warning" size={16} />
        <bdi className="sy-conflict__title">{title}</bdi>
        {reason ? <span className="sy-conflict__reason">{reason}</span> : null}
      </header>
      <div className="sy-conflict__versions">
        <div className="sy-version sy-version--mine">
          <div className="sy-version__label">{t('sync.yours')}</div>
          <Version item={item} value={item.mine} other={item.theirs} config={config} />
        </div>
        <div className="sy-version sy-version--theirs">
          <div className="sy-version__label">{t('sync.teams')}</div>
          <Version item={item} value={item.theirs} other={item.mine} config={config} />
        </div>
      </div>
      <div className={`sy-conflict__choice${editable ? '' : ' is-preset'}`}>
        <RadioGroup<Resolution>
          label={t('sync.resolveLabel')}
          direction="row"
          value={resolution}
          onChange={onResolve}
          options={[
            { value: 'mine', label: t('sync.resolveMine'), disabled: !editable },
            { value: 'theirs', label: t('sync.resolveTheirs'), disabled: !editable },
            { value: 'aside', label: t('sync.resolveAside'), disabled: !editable },
          ]}
          testId="resolve"
        />
      </div>
    </article>
  );
}

const OPTION_TEXT: Record<Option, { title: MessageKey; text: MessageKey; apply: MessageKey }> = {
  push: { title: 'sync.optPushTitle', text: 'sync.optPushText', apply: 'sync.applyPush' },
  'keep-mine': { title: 'sync.optKeepMineTitle', text: 'sync.optKeepMineText', apply: 'sync.applyUpdate' },
  update: { title: 'sync.optUpdateTitle', text: 'sync.optUpdateText', apply: 'sync.applyUpdate' },
  aside: { title: 'sync.optAsideTitle', text: 'sync.optAsideText', apply: 'sync.applyAside' },
  custom: { title: 'sync.optCustomTitle', text: 'sync.optCustomText', apply: 'sync.applyCustom' },
};

const OPTION_RESOLUTION: Record<Exclude<Option, 'custom'>, Resolution> = {
  push: 'mine',
  'keep-mine': 'mine',
  update: 'theirs',
  aside: 'aside',
};

/** The graphic overview of a merge: what the team changed, what I changed, where we collide, and the decision. */
export function MergeDialog({ dialog }: { dialog: Extract<DialogState, { type: 'merge' }> }): ReactNode {
  const tr = useT();
  const { t, tn } = tr;
  const { session } = dialog;
  const base = useApp((s) => s.base);
  const working = useApp((s) => s.working);
  const busy = useApp((s) => s.busy);
  const publishMode = session.mode === 'publish';
  const { items } = session.result;

  // Keeping mine aside is the default: it is the one choice that loses nothing.
  const [option, setOption] = useState<Option>('aside');
  const [choices, setChoices] = useState<Record<string, Resolution>>({});
  const [alsoPublish, setAlsoPublish] = useState(false);

  const config = useMemo(() => lookupConfig(session.theirs.config, working.config, base.config), [session.theirs, working, base]);
  const conflicts = useMemo(() => items.filter((item) => item.status === 'conflict'), [items]);
  const hasConflicts = conflicts.length > 0;

  const { incomingRows, mineRows } = useMemo(() => {
    const row = (item: MergeItem, side: 'mine' | 'theirs'): ChangeRow => {
      const change = side === 'mine' ? item.mineChange : item.theirsChange;
      const value = (side === 'mine' ? item.mine : item.theirs) ?? item.base;
      return { key: item.key, change: change === 'none' ? 'modified' : change, ...describeItem(item, value, config, tr) };
    };
    const quiet = items.filter((item) => item.status !== 'conflict');
    return {
      incomingRows: quiet.filter((item) => item.theirsChange !== 'none').map((item) => row(item, 'theirs')),
      // A change both sides made identically is already in the team's copy: not "mine" any more.
      mineRows: quiet.filter((item) => item.mineChange !== 'none' && item.status !== 'same').map((item) => row(item, 'mine')),
    };
  }, [items, config, tr]);

  const weeks = useMemo(() => {
    const byWeek = new Map<IsoDate, MergeItem[]>();
    for (const item of items) {
      if (item.kind !== 'event' || !item.weekStart) continue;
      byWeek.set(item.weekStart, [...(byWeek.get(item.weekStart) ?? []), item]);
    }
    return [...byWeek.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([weekStart, weekItems]) => {
        const changed = new Set(weekItems.map((item) => item.id));
        return { weekStart, items: weekItems, context: getWeek(session.theirs, weekStart).events.filter((event) => !changed.has(event.id)) };
      });
  }, [items, session.theirs]);

  const resolutionOf = (key: string): Resolution => (option === 'custom' ? (choices[key] ?? 'aside') : OPTION_RESOLUTION[option]);

  const operating = busy !== null && busy !== 'checking';
  const run = (choice: MergeChoice): void => void actions.resolveMerge(choice);
  const apply = (): void => {
    if (option === 'custom') {
      const resolutions = Object.fromEntries(conflicts.map((item) => [item.key, resolutionOf(item.key)]));
      run({ resolutions, defaultResolution: 'aside', then: publishMode && alsoPublish ? 'publish' : 'keep-local' });
    } else {
      run({ resolutions: {}, defaultResolution: OPTION_RESOLUTION[option], then: option === 'push' ? 'publish' : 'keep-local' });
    }
  };
  const jumpTo = (key: string): void => document.getElementById(`conflict-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const options: Option[] = publishMode ? ['push', 'update', 'aside', 'custom'] : ['keep-mine', 'update', 'aside', 'custom'];
  const mineTotal = mineRows.length + conflicts.length;

  return (
    <Modal
      title={publishMode ? t('sync.mergeTitlePublish') : t('sync.mergeTitleUpdate')}
      subtitle={t('sync.mergeSubtitle')}
      icon="git-merge"
      tone={hasConflicts ? 'warning' : 'info'}
      size="xl"
      onClose={() => actions.closeDialog()}
      locked={operating}
      testId="merge-dialog"
      footer={
        <>
          <Button onClick={() => actions.closeDialog()} disabled={operating} testId="merge-cancel">
            {t('common.cancel')}
          </Button>
          {hasConflicts ? (
            <Button variant="primary" icon="check" busy={operating} onClick={apply} testId="merge-apply">
              {t(OPTION_TEXT[option].apply)}
            </Button>
          ) : (
            <>
              <Button disabled={operating} onClick={() => run({ resolutions: {}, defaultResolution: 'theirs', then: 'keep-local' })} testId="merge-update-only">
                {t('sync.updateOnly')}
              </Button>
              <Button variant="primary" icon="cloud-up" busy={operating} onClick={() => run({ resolutions: {}, defaultResolution: 'theirs', then: 'publish' })} testId="merge-combine-save">
                {t('sync.combineAndSave')}
              </Button>
            </>
          )}
        </>
      }
    >
      {session.changedAgain ? (
        <Callout tone="info" testId="merge-changed-again">
          {t('sync.mergeChangedAgain')}
        </Callout>
      ) : null}
      {session.theirProblems.length > 0 ? <Callout tone="warning">{t('sync.teamProblemFiles')}</Callout> : null}

      <div className="sy-overview">
        <MergeGraph incoming={session.incoming} mineCount={mineTotal} conflictCount={conflicts.length} />
        <div className="sy-counts">
          <Badge tone="theirs" icon="cloud-down" testId="merge-count-theirs">
            {tn('sync.countIncoming', session.result.theirsCount)}
          </Badge>
          <Badge tone="mine" icon="cloud-up" testId="merge-count-mine">
            {tn('sync.countMine', mineTotal)}
          </Badge>
          <Badge tone={hasConflicts ? 'conflict' : 'success'} icon={hasConflicts ? 'warning' : 'check'} testId="merge-count-conflicts">
            {hasConflicts ? tn('sync.countConflicts', conflicts.length) : t('sync.noCollisionsTitle')}
          </Badge>
        </div>
      </div>

      {weeks.length > 0 ? (
        <section className="sy-section">
          <div className="sy-weeks">
            {weeks.map((week) => (
              <MiniWeek key={week.weekStart} weekStart={week.weekStart} items={week.items} context={week.context} config={config} onPickConflict={jumpTo} />
            ))}
          </div>
          <MiniWeekLegend />
        </section>
      ) : null}

      {hasConflicts ? (
        <>
          {/* The decision first, then the collisions it is about ("... every collision below"). */}
          <section className="sy-section">
            <h3>{t('sync.whatNext')}</h3>
            <div className="sy-options" role="radiogroup" aria-label={t('sync.whatNext')}>
              {options.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="radio"
                  aria-checked={option === entry}
                  className={`sy-option${option === entry ? ' is-selected' : ''}`}
                  onClick={() => setOption(entry)}
                  data-testid={`merge-option-${entry}`}
                >
                  <span className="sy-option__radio" />
                  <span className="sy-option__body">
                    <strong>{t(OPTION_TEXT[entry].title)}</strong>
                    <span>{t(OPTION_TEXT[entry].text)}</span>
                  </span>
                </button>
              ))}
            </div>
            {option === 'custom' && publishMode ? (
              <Checkbox checked={alsoPublish} onChange={setAlsoPublish} label={t('sync.alsoPublish')} testId="merge-also-publish" />
            ) : null}
          </section>

          <section className="sy-section">
            <h3>{tn('sync.collisionsTitle', conflicts.length)}</h3>
            <div className="sy-conflicts">
              {conflicts.map((item) => (
                <ConflictCard
                  key={item.key}
                  item={item}
                  config={config}
                  resolution={resolutionOf(item.key)}
                  editable={option === 'custom'}
                  onResolve={(resolution) => setChoices((current) => ({ ...current, [item.key]: resolution }))}
                />
              ))}
            </div>
          </section>
        </>
      ) : (
        <Callout tone="success" title={t('sync.noCollisionsTitle')} testId="merge-no-collisions">
          {t('sync.noCollisionsText')}
        </Callout>
      )}

      {incomingRows.length > 0 ? (
        <details className="sy-fold" open={!hasConflicts}>
          <summary>{tn('sync.incomingList', incomingRows.length)}</summary>
          <ChangeList rows={incomingRows} tone="theirs" testId="merge-incoming" />
        </details>
      ) : null}
      {mineRows.length > 0 ? (
        <details className="sy-fold" open={!hasConflicts}>
          <summary>{tn('sync.mineList', mineRows.length)}</summary>
          <ChangeList rows={mineRows} tone="mine" testId="merge-mine" />
        </details>
      ) : null}
    </Modal>
  );
}
