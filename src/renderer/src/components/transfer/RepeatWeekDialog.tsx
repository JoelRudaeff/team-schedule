import { useMemo, useState, type ReactNode } from 'react';
import { addDays, diffDays, weekStartOf } from '@shared/dates';
import { getWeek } from '@shared/model';
import type { IsoDate } from '@shared/types';
import { useT } from '../../i18n/useT';
import { formatWeekRange } from '../../lib/format';
import { actions, useApp } from '../../store';
import { Button, Callout, Checkbox, DateInput, Field, Modal, NumberInput, RadioGroup } from '../ui';
import './transfer.css';

type Target = 'next' | 'count' | 'until-end' | 'specific';

/** Copy this week's events into other weeks ("repeat"). */
export function RepeatWeekDialog(): ReactNode {
  const { t, tn, lang } = useT();
  const weekStart = useApp((s) => s.weekStart);
  const working = useApp((s) => s.working);
  const source = getWeek(working, weekStart);
  const courseEnd = working.config.course.endDate;

  const [target, setTarget] = useState<Target>('next');
  const [count, setCount] = useState<number | null>(4);
  const [specific, setSpecific] = useState<IsoDate | null>(addDays(weekStart, 7));
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [copyTitle, setCopyTitle] = useState(false);

  const weeksToEnd = courseEnd && weekStartOf(courseEnd) > weekStart ? diffDays(weekStart, weekStartOf(courseEnd)) / 7 : 0;

  const targetWeeks = useMemo((): IsoDate[] => {
    const following = (n: number): IsoDate[] => Array.from({ length: n }, (_, index) => addDays(weekStart, 7 * (index + 1)));
    if (target === 'next') return following(1);
    if (target === 'count') return following(count ?? 0);
    if (target === 'until-end') return following(weeksToEnd);
    if (!specific) return [];
    const week = weekStartOf(specific);
    return week === weekStart ? [] : [week];
  }, [target, count, specific, weekStart, weeksToEnd]);

  const existing = targetWeeks.reduce((total, week) => total + getWeek(working, week).events.length, 0);
  const nothing = source.events.length === 0;

  const repeat = (): void => {
    const written = actions.repeatWeek({ sourceWeek: weekStart, targetWeeks, mode, copyTitle });
    if (written > 0) actions.toast({ kind: 'success', message: tn('transfer.repeatDone', written) });
    actions.closeDialog();
  };

  return (
    <Modal
      title={t('transfer.repeatTitle')}
      subtitle={`${t('transfer.repeatSource', { range: formatWeekRange(weekStart, lang) })} · ${tn('transfer.importEvents', source.events.length)}`}
      icon="repeat"
      onClose={() => actions.closeDialog()}
      testId="repeat-week-dialog"
      footer={
        <>
          <Button onClick={() => actions.closeDialog()}>{t('common.cancel')}</Button>
          <Button variant="primary" icon="repeat" disabled={nothing || targetWeeks.length === 0} onClick={repeat} testId="repeat-week-confirm">
            {t('transfer.repeatButton')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('transfer.repeatIntro')}</p>
      {nothing ? <Callout tone="warning">{t('transfer.repeatNothing')}</Callout> : null}

      <Field label={t('transfer.repeatTarget')}>
        <RadioGroup<Target>
          label={t('transfer.repeatTarget')}
          value={target}
          onChange={setTarget}
          options={[
            { value: 'next', label: t('transfer.repeatNext'), hint: formatWeekRange(addDays(weekStart, 7), lang) },
            { value: 'count', label: t('transfer.repeatCount') },
            ...(weeksToEnd > 0 ? [{ value: 'until-end' as const, label: tn('transfer.repeatUntilEnd', weeksToEnd) }] : []),
            { value: 'specific', label: t('transfer.repeatSpecific') },
          ]}
          testId="repeat-target"
        />
      </Field>

      {target === 'count' ? (
        <Field label={t('transfer.repeatCountLabel')} htmlFor="tr-count">
          <NumberInput id="tr-count" value={count} onChange={setCount} min={1} max={104} testId="repeat-count" />
        </Field>
      ) : null}
      {target === 'specific' ? (
        <Field label={t('transfer.repeatSpecificLabel')} htmlFor="tr-specific" hint={specific ? formatWeekRange(weekStartOf(specific), lang) : undefined}>
          <DateInput id="tr-specific" value={specific} onChange={setSpecific} testId="repeat-specific" />
        </Field>
      ) : null}

      <Field label={t('transfer.repeatMode')}>
        <RadioGroup<'add' | 'replace'>
          label={t('transfer.repeatMode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'add', label: t('transfer.repeatAdd') },
            { value: 'replace', label: t('transfer.repeatReplace') },
          ]}
          testId="repeat-mode"
        />
      </Field>
      {mode === 'replace' && existing > 0 ? (
        <Callout tone="warning" testId="repeat-replace-warning">
          {tn('transfer.repeatReplaceWarn', existing)}
        </Callout>
      ) : null}

      {source.title ? <Checkbox checked={copyTitle} onChange={setCopyTitle} label={t('transfer.repeatCopyTitle')} testId="repeat-copy-title" /> : null}
    </Modal>
  );
}
