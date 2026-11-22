import { useMemo, useState, type ReactNode } from 'react';
import { weekStartOf } from '@shared/dates';
import { getWeek } from '@shared/model';
import type { IsoDate } from '@shared/types';
import { importWeekTemplate } from '@shared/weekTemplate';
import { useT } from '../../i18n/useT';
import { dayName, formatWeekRange } from '../../lib/format';
import { actions, useApp } from '../../store';
import type { DialogState } from '../../store/types';
import { Button, Callout, Checkbox, DateInput, Field, Modal, RadioGroup } from '../ui';
import './transfer.css';

const PREVIEW_ROWS = 8;

/** Load a saved week file into a week of the schedule. */
export function ImportWeekDialog({ dialog }: { dialog: Extract<DialogState, { type: 'import-week' }> }): ReactNode {
  const { t, tn, lang } = useT();
  const { template, fileName } = dialog;
  const weekStart = useApp((s) => s.weekStart);
  const working = useApp((s) => s.working);
  const [targetDate, setTargetDate] = useState<IsoDate | null>(weekStart);
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [applyTitle, setApplyTitle] = useState(template.title !== '');

  const targetWeek = targetDate ? weekStartOf(targetDate) : null;
  const existing = targetWeek ? getWeek(working, targetWeek).events.length : 0;

  // A dry run tells which list entries the schedule would gain.
  const created = useMemo(() => {
    if (!targetWeek) return [];
    let n = 0;
    const result = importWeekTemplate(working, template, { targetWeek, mode, applyTitle }, () => `preview-${++n}`).created;
    const parts: string[] = [];
    if (result.subjects > 0) parts.push(`${t('common.subjects')} (${result.subjects})`);
    if (result.locations > 0) parts.push(`${t('common.locations')} (${result.locations})`);
    if (result.teachers > 0) parts.push(`${t('common.teachers')} (${result.teachers})`);
    if (result.classes > 0) parts.push(`${t('common.classes')} (${result.classes})`);
    return parts;
  }, [working, template, targetWeek, mode, applyTitle, t]);

  const load = (): void => {
    if (!targetWeek) return;
    const result = actions.importWeek(template, { targetWeek, mode, applyTitle });
    if (!result) return;
    actions.goToWeek(targetWeek);
    actions.closeDialog();
  };

  return (
    <Modal
      title={t('transfer.importTitle')}
      subtitle={<bdi dir="ltr">{fileName}</bdi>}
      icon="upload"
      onClose={() => actions.closeDialog()}
      testId="import-week-dialog"
      footer={
        <>
          <Button onClick={() => actions.closeDialog()}>{t('common.cancel')}</Button>
          <Button variant="primary" icon="upload" disabled={!targetWeek || template.events.length === 0} onClick={load} testId="import-week-confirm">
            {t('transfer.importButton')}
          </Button>
        </>
      }
    >
      <div className="tr-source">
        <strong>
          {template.title ? <bdi>{template.title} · </bdi> : null}
          {tn('transfer.importEvents', template.events.length)}
        </strong>
        <span className="muted">{t('transfer.importSource', { range: formatWeekRange(template.sourceWeek, lang) })}</span>
        <ul className="tr-preview">
          {template.events.slice(0, PREVIEW_ROWS).map((event, index) => (
            <li key={index}>
              <span className="tr-preview__when">
                {dayName(event.day, lang, 'short')} <bdi dir="ltr">{`${event.start}–${event.end}`}</bdi>
              </span>
              <bdi>{event.title || event.subject?.name || t('common.untitledEvent')}</bdi>
              {event.location ? <bdi className="faint">{event.location.name}</bdi> : null}
            </li>
          ))}
          {template.events.length > PREVIEW_ROWS ? <li className="faint">{t('transfer.importMore', { count: template.events.length - PREVIEW_ROWS })}</li> : null}
        </ul>
      </div>

      <Field label={t('transfer.importTarget')} htmlFor="tr-target" hint={targetWeek ? formatWeekRange(targetWeek, lang) : t('transfer.importTargetHint')}>
        <DateInput id="tr-target" value={targetDate} onChange={setTargetDate} testId="import-target" />
      </Field>

      <Field label={t('transfer.importMode')}>
        <RadioGroup<'add' | 'replace'>
          label={t('transfer.importMode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'add', label: t('transfer.importAdd') },
            { value: 'replace', label: t('transfer.importReplace') },
          ]}
          testId="import-mode"
        />
      </Field>
      {mode === 'replace' && existing > 0 ? (
        <Callout tone="warning" testId="import-replace-warning">
          {tn('transfer.importReplaceWarn', existing)}
        </Callout>
      ) : null}

      {template.title ? (
        <Checkbox checked={applyTitle} onChange={setApplyTitle} label={t('transfer.importUseTitle', { title: template.title })} testId="import-apply-title" />
      ) : null}

      {created.length > 0 ? <Callout tone="info">{t('transfer.importCreates', { list: created.join(', ') })}</Callout> : null}
    </Modal>
  );
}
