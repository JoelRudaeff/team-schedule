import { useMemo, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { describeDiff, lookupConfig } from '../../lib/describe';
import { actions, useApp } from '../../store';
import type { DialogState } from '../../store/types';
import { Button, Field, Icon, Modal, TextInput } from '../ui';
import { ChangeList, type ChangeRow } from './ChangeList';
import './sync.css';

/** The confirmation before anything goes to the team: what saving means, and exactly what will be sent. */
export function PublishDialog({ dialog }: { dialog: Extract<DialogState, { type: 'publish' }> }): ReactNode {
  const tr = useT();
  const { t, tn } = tr;
  const diff = useApp((s) => s.diff);
  const base = useApp((s) => s.base);
  const working = useApp((s) => s.working);
  const userName = useApp((s) => s.settings.userName);
  const busy = useApp((s) => s.busy);
  const [note, setNote] = useState(dialog.note ?? '');

  const rows = useMemo((): ChangeRow[] => {
    const config = lookupConfig(working.config, base.config);
    return diff.map((item) => ({ key: item.key, change: item.change, ...describeDiff(item, config, tr) }));
  }, [diff, working.config, base.config, tr]);

  const operating = busy !== null && busy !== 'checking';
  const confirm = (): void => void actions.confirmPublish(note);

  return (
    <Modal
      title={t('sync.publishTitle')}
      icon="cloud-up"
      onClose={() => actions.closeDialog()}
      locked={operating}
      testId="publish-dialog"
      footer={
        <>
          <Button onClick={() => actions.closeDialog()} disabled={operating} testId="publish-cancel">
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="cloud-up" busy={operating} onClick={confirm} testId="publish-confirm">
            {t('sync.publishConfirm')}
          </Button>
        </>
      }
    >
      <div className="sy-explain">
        <p>{t('sync.publishIntro')}</p>
        <ol>
          <li>
            <Icon name="user" size={14} />
            <span>{t('sync.publishStep1', { name: userName })}</span>
          </li>
          <li>
            <Icon name="cloud-up" size={14} />
            <span>{t('sync.publishStep2')}</span>
          </li>
          <li>
            <Icon name="users" size={14} />
            <span>{t('sync.publishStep3')}</span>
          </li>
        </ol>
      </div>

      <section className="sy-section">
        <h3>{tn('sync.publishChanges', rows.length)}</h3>
        <ChangeList rows={rows} tone="mine" testId="publish-changes" />
      </section>

      <Field label={t('sync.publishNote')} htmlFor="publish-note">
        <TextInput
          id="publish-note"
          value={note}
          onChange={setNote}
          onEnter={confirm}
          placeholder={t('sync.publishNotePlaceholder')}
          maxLength={200}
          data-autofocus
          testId="publish-note"
        />
      </Field>
    </Modal>
  );
}
