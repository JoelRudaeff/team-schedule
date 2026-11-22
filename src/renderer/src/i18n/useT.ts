import { useMemo } from 'react';
import { useApp } from '../store';
import { translatorFor, type Translator } from './index';

/**
 * Translation hook for components:
 *
 *   const { t, tn, lang, dir } = useT();
 *   <button>{t('common.save')}</button>
 *   <span>{tn('sync.unpublished', count)}</span>
 */
export function useT(): Translator {
  const lang = useApp((s) => s.lang);
  return useMemo(() => translatorFor(lang), [lang]);
}
