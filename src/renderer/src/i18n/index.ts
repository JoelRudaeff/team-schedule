/**
 * Translations (English + Hebrew). Pure TypeScript — no React, usable from the store and from tests.
 *
 * Keys are `namespace.name`, e.g. `t('toolbar.today')`. English (`en/`) is the source of
 * truth for the key set; the Hebrew tables are type-checked against it, so a missing or
 * extra Hebrew key is a compile error.
 *
 * Placeholders: `{name}` in a text is replaced from the params object.
 * Plurals: define `<key>_one` and `<key>_other` and call `tn('<key>', count)`; `{count}`
 * is available in both texts.
 */
import type { Lang } from '@shared/types';
import { en } from './en';
import { he } from './he';

export type Messages = typeof en;
type Namespace = keyof Messages & string;

/** Every valid `namespace.name` key. */
export type MessageKey = {
  [N in Namespace]: `${N}.${keyof Messages[N] & string}`;
}[Namespace];

/** Keys that have `_one` / `_other` variants (written without the suffix). */
export type PluralKey = MessageKey extends infer K ? (K extends `${infer Base}_other` ? Base : never) : never;

export type MessageParams = Record<string, string | number>;

const TABLES: Record<Lang, Record<string, Record<string, string>>> = { en, he };

function lookup(lang: Lang, key: string): string | undefined {
  const dot = key.indexOf('.');
  if (dot < 0) return undefined;
  return TABLES[lang][key.slice(0, dot)]?.[key.slice(dot + 1)];
}

export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const text = lookup(lang, key) ?? lookup('en', key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function translatePlural(lang: Lang, key: PluralKey, count: number, params?: MessageParams): string {
  const suffix = count === 1 ? '_one' : '_other';
  return translate(lang, `${key}${suffix}` as MessageKey, { count, ...params });
}

export function dirOf(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

/** Language to start with on a computer that has no saved choice yet. */
export function languageForLocale(systemLocale: string): Lang {
  return /^(he|iw)\b/i.test(systemLocale) ? 'he' : 'en';
}

export type Translator = {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  t: (key: MessageKey, params?: MessageParams) => string;
  tn: (key: PluralKey, count: number, params?: MessageParams) => string;
};

export function translatorFor(lang: Lang): Translator {
  return {
    lang,
    dir: dirOf(lang),
    t: (key, params) => translate(lang, key, params),
    tn: (key, count, params) => translatePlural(lang, key, count, params),
  };
}
