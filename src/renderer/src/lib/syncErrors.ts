import type { SyncError } from '@shared/api';
import type { MessageKey } from '../i18n';

/** The user-facing sentence for each kind of repository problem. */
export const SYNC_ERROR_TEXT: Record<SyncError['code'], MessageKey> = {
  offline: 'store.errOffline',
  auth: 'store.errAuth',
  'not-found': 'store.errNotFound',
  'dubious-ownership': 'store.errDubious',
  'branch-missing': 'store.errBranchMissing',
  timeout: 'store.errTimeout',
  'git-missing': 'store.errGitMissing',
  'invalid-url': 'store.errInvalidUrl',
  unknown: 'store.errUnknown',
};
