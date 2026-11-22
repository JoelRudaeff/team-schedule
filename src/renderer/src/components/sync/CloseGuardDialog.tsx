import type { ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { actions, useApp } from '../../store';
import type { DialogState } from '../../store/types';
import { Button, Modal } from '../ui';
import './sync.css';

/**
 * Shown when the window is closed while there is work that would be lost or that the team
 * cannot see yet. It lies over the dialog that was open at that moment (`dialog.covered`),
 * and "Cancel" leads back into that dialog with everything that was typed.
 */
export function CloseGuardDialog({ dialog }: { dialog: Extract<DialogState, { type: 'close-guard' }> }): ReactNode {
  const { t, tn } = useT();
  const unpublished = useApp((s) => s.diff.length);
  const covering = dialog.covered !== null;

  const saveNow = (): void => {
    actions.closeDialog();
    actions.requestPublish();
  };

  return (
    <Modal
      title={dialog.draft && unpublished === 0 ? t('sync.closeDraftTitle') : t('sync.closeTitle')}
      icon="cloud-up"
      tone="warning"
      size="sm"
      onClose={() => actions.closeDialog()}
      testId="close-guard-dialog"
      footer={
        <>
          <Button onClick={() => actions.closeDialog()} testId="close-guard-cancel" data-autofocus={covering ? true : undefined}>
            {covering ? t('sync.closeBack') : t('common.cancel')}
          </Button>
          <Button onClick={() => actions.closeWindowNow()} testId="close-guard-close">
            {t('sync.closeAnyway')}
          </Button>
          {/* Saving from here would replace the dialog underneath; with one open, the way to save is back through it. */}
          {covering ? null : (
            <Button variant="primary" icon="cloud-up" onClick={saveNow} testId="close-guard-save" data-autofocus>
              {t('sync.closeSaveNow')}
            </Button>
          )}
        </>
      }
    >
      {dialog.draft ? <p data-testid="close-guard-draft">{t('sync.closeDraftText')}</p> : null}
      {unpublished > 0 || !dialog.draft ? <p>{tn('sync.closeText', Math.max(1, unpublished))}</p> : null}
    </Modal>
  );
}
