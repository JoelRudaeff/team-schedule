/** Store-connected pieces that App.tsx renders once: toasts, the busy overlay and the two generic dialogs. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MessageKey } from '../../i18n';
import { useT } from '../../i18n/useT';
import { actions, getState, useApp } from '../../store';
import type { BusyKind, DialogState, ToastItem } from '../../store/types';
import { Button, DetailsBox, IconButton, Spinner } from './controls';
import { Icon } from './icons';
import { Modal } from './overlays';
import type { IconName } from './types';

const TOAST_LIFETIME_MS = 6000;

const TOAST_ICON: Record<ToastItem['kind'], IconName> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

function Toast({ toast }: { toast: ToastItem }): ReactNode {
  const { t } = useT();
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (toast.sticky || hovered) return;
    const timer = setTimeout(() => actions.dismissToast(toast.id), TOAST_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [toast.id, toast.sticky, hovered]);

  return (
    <div
      className={`ui-toast ui-toast--${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid={`toast-${toast.kind}`}
    >
      <Icon name={TOAST_ICON[toast.kind]} size={18} className="ui-toast__icon" />
      <div className="ui-toast__body">
        <div className="ui-toast__message user-text">{toast.message}</div>
        {toast.detail ? <DetailsBox text={toast.detail} /> : null}
        {toast.action ? (
          <div className="ui-toast__action">
            <Button
              size="sm"
              onClick={() => {
                const run = toast.action?.run;
                actions.dismissToast(toast.id);
                run?.();
              }}
            >
              {toast.action.label}
            </Button>
          </div>
        ) : null}
      </div>
      <IconButton icon="close" size="sm" label={t('ui.dismiss')} onClick={() => actions.dismissToast(toast.id)} />
    </div>
  );
}

export function ToastHost(): ReactNode {
  const toasts = useApp((s) => s.toasts);
  const dialogOpen = useApp((s) => s.dialog !== null);
  // While a dialog is open, plain news waits its turn: a toast in the corner would cover the
  // dialog's buttons. Problems are shown at once.
  const shown = dialogOpen ? toasts.filter((toast) => toast.kind === 'error' || toast.kind === 'warning') : toasts;
  if (shown.length === 0) return null;
  return createPortal(
    <div className="ui-toasts" data-testid="toasts">
      {shown.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}

const BUSY_LABEL: Record<Exclude<BusyKind, 'checking'>, MessageKey> = {
  connecting: 'ui.busyConnecting',
  creating: 'ui.busyCreating',
  updating: 'ui.busyUpdating',
  publishing: 'ui.busyPublishing',
  discarding: 'ui.busyDiscarding',
};

/** Blocks the whole window while a sync operation runs. A background check never blocks. */
export function BusyOverlay(): ReactNode {
  const busy = useApp((s) => s.busy);
  const { t } = useT();
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (busy && busy !== 'checking') layer.current?.focus();
  }, [busy]);

  if (!busy || busy === 'checking') return null;
  return createPortal(
    <div
      ref={layer}
      className="ui-busy"
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={t(BUSY_LABEL[busy])}
      tabIndex={-1}
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      data-testid="busy-overlay"
    >
      <div className="ui-busy__card">
        <Spinner size={28} />
        <div>{t(BUSY_LABEL[busy])}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Closes the dialog unless the action that just ran opened a different one. */
function closeIfStill(dialog: DialogState): void {
  if (getState().dialog === dialog) actions.closeDialog();
}

export function ConfirmDialog({ dialog }: { dialog: Extract<DialogState, { type: 'confirm' }> }): ReactNode {
  const { t } = useT();
  const [running, setRunning] = useState(false);

  const confirm = async (): Promise<void> => {
    setRunning(true);
    try {
      await dialog.onConfirm();
    } finally {
      setRunning(false);
      closeIfStill(dialog);
    }
  };

  return (
    <Modal
      title={dialog.title}
      size="sm"
      icon={dialog.danger ? 'warning' : 'info'}
      tone={dialog.danger ? 'danger' : 'info'}
      onClose={() => closeIfStill(dialog)}
      locked={running}
      testId="confirm-dialog"
      footer={
        <>
          <Button onClick={() => closeIfStill(dialog)} disabled={running} testId="confirm-cancel">
            {dialog.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={dialog.danger ? 'danger' : 'primary'} busy={running} onClick={() => void confirm()} testId="confirm-ok" data-autofocus>
            {dialog.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="user-text">{dialog.message}</p>
      {dialog.detail ? <pre className="ui-confirm__detail mono ltr selectable">{dialog.detail}</pre> : null}
    </Modal>
  );
}

export function ErrorDialog({ dialog }: { dialog: Extract<DialogState, { type: 'error' }> }): ReactNode {
  const { t } = useT();
  const [running, setRunning] = useState(false);

  const run = async (action: () => void | Promise<void>): Promise<void> => {
    setRunning(true);
    try {
      await action();
    } finally {
      setRunning(false);
      closeIfStill(dialog);
    }
  };

  return (
    <Modal
      title={dialog.title}
      icon="error"
      tone="danger"
      onClose={() => closeIfStill(dialog)}
      locked={running}
      testId="error-dialog"
      footer={
        <>
          {(dialog.actions ?? []).map((action) => (
            <Button key={action.label} variant={action.primary ? 'primary' : 'secondary'} disabled={running} onClick={() => void run(action.run)}>
              {action.label}
            </Button>
          ))}
          <Button onClick={() => closeIfStill(dialog)} disabled={running} testId="error-close" data-autofocus>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <p className="selectable user-text">{dialog.message}</p>
      {dialog.detail ? <DetailsBox text={dialog.detail} defaultOpen /> : null}
    </Modal>
  );
}
