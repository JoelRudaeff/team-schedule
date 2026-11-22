import type { ReactNode } from 'react';
import type { Lang } from '@shared/types';
import { useT } from '../../i18n/useT';
import { actions } from '../../store';
import './common.css';

const LANGUAGES: readonly { lang: Lang; label: string; short: string }[] = [
  { lang: 'he', label: 'עברית', short: 'עב' },
  { lang: 'en', label: 'English', short: 'EN' },
];

/** Two-segment language toggle (Hebrew / English). `compact` shows short labels for the toolbar. */
export function LanguageSwitch({ compact = false }: { compact?: boolean }): ReactNode {
  const { lang, t } = useT();
  return (
    <div className="lang-switch" role="group" aria-label={t('setup.language')} data-testid="lang-switch">
      {LANGUAGES.map((entry) => (
        <button
          key={entry.lang}
          type="button"
          className={`lang-switch__option${entry.lang === lang ? ' is-active' : ''}`}
          aria-pressed={entry.lang === lang}
          title={entry.label}
          lang={entry.lang}
          onClick={() => actions.setLanguage(entry.lang)}
          data-testid={`lang-${entry.lang}`}
        >
          {compact ? entry.short : entry.label}
        </button>
      ))}
    </div>
  );
}
