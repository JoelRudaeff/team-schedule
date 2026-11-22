import type { ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { actions, useApp } from '../../store';
import { Button, Modal } from '../ui';
import './sync.css';

/** Shown when the window is closed while there is work the team cannot see yet. */
export function CloseGuardDialog(): ReactNode {
  const { t, tn } = useT();
  const count = useApp((s) => Math.max(1, s.diff.length));

  const saveNow = (): void => {
    actions.closeDialog();
    actions.requestPublish();
  };

  return (
    <Modal
      title={t('sync.closeTitle')}
      icon="cloud-up"
      tone="warning"
      size="sm"
      onClose={() => actions.closeDialog()}
      testId="close-guard-dialog"
      footer={
        <>
          <Button onClick={() => actions.closeDialog()} testId="close-guard-cancel">
            {t('common.cancel')}
          </Button>
          <Button onClick={() => actions.closeWindowNow()} testId="close-guard-close">
            {t('sync.closeAnyway')}
          </Button>
          <Button variant="primary" icon="cloud-up" onClick={saveNow} testId="close-guard-save" data-autofocus>
            {t('sync.closeSaveNow')}
          </Button>
        </>
      }
    >
      <p>{tn('sync.closeText', count)}</p>
    </Modal>
  );
}
