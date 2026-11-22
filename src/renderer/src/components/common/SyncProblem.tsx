import type { ReactNode } from 'react';
import type { SyncError } from '@shared/api';
import { useT } from '../../i18n/useT';
import { SYNC_ERROR_TEXT } from '../../lib/syncErrors';
import { Button, Callout, DetailsBox } from '../ui';
import './common.css';

interface SyncProblemProps {
  title: string;
  error: SyncError;
  /** Called after the user agreed to trust the folder git complained about (`error.trustPath`). */
  onTrust?: (path: string) => void;
  /** Called when the user insists on a branch the repository does not have (`branch-missing`). */
  onCreateBranch?: () => void;
  testId?: string;
}

/** A repository problem in words, with git's own output on request and the remedy when there is one. */
export function SyncProblem({ title, error, onTrust, onCreateBranch, testId }: SyncProblemProps): ReactNode {
  const { t } = useT();
  const trustPath = error.code === 'dubious-ownership' ? error.trustPath : undefined;
  return (
    <Callout tone="danger" title={title} testId={testId}>
      <span className="selectable">{t(SYNC_ERROR_TEXT[error.code])}</span>
      {trustPath && onTrust ? (
        <div className="sync-problem__trust">
          <span>{t('setup.trustText')}</span>
          <code className="mono ltr selectable">{trustPath}</code>
          <Button size="sm" icon="lock" onClick={() => onTrust(trustPath)} testId="trust-and-retry">
            {t('setup.trustAndRetry')}
          </Button>
        </div>
      ) : null}
      {error.code === 'branch-missing' ? (
        <div className="sync-problem__trust" data-testid="branch-missing">
          {error.branches && error.branches.length > 0 ? <span>{t('setup.branchesHere', { list: error.branches.join(', ') })}</span> : null}
          <span>{t('setup.branchMissingText')}</span>
          {onCreateBranch ? (
            <Button size="sm" icon="git-branch" onClick={onCreateBranch} testId="create-branch">
              {t('setup.createBranch')}
            </Button>
          ) : null}
        </div>
      ) : error.detail ? (
        <DetailsBox text={error.detail} />
      ) : null}
    </Callout>
  );
}
