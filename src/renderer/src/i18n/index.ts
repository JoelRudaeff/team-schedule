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

/** Unicode "isolates": invisible marks that keep a piece of text from re-ordering what surrounds it. */
const LRI = '\u2066';
const FSI = '\u2068';
const PDI = '\u2069';

/**
 * `text` in its own direction, without disturbing the sentence around it. A sentence that
 * contains a name typed by a user would otherwise be laid out by that name: "Room A" at the
 * start of a Hebrew sentence turns the whole sentence left-to-right and scrambles its words.
 */
export function isolate(text: string): string {
  return `${FSI}${text}${PDI}`;
}

/** `text` shown left to right whatever surrounds it: time and number ranges such as "09:00–10:30". */
export function ltr(text: string): string {
  return `${LRI}${text}${PDI}`;
}

/** The text without isolates, for places that are not shown as text (file names, comparisons in tests). */
export function withoutIsolates(text: string): string {
  return text.replace(/[\u2066-\u2069]/g, '');
}

/**
 * The text for `key` with its `{placeholders}` filled in. Every text that is filled in is
 * isolated (see `isolate`), so the sentence keeps the direction of the interface whatever a
 * name, a date or a path inside it looks like. Numbers are put in as they are.
 */
export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const text = lookup(lang, key) ?? lookup('en', key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    const value = params[name];
    return typeof value === 'number' ? String(value) : isolate(value);
  });
}

/**
 * `<key>_one` for exactly one, `<key>_two` for exactly two where the table has it (Hebrew
 * has words of its own for two: שעתיים, יומיים), `<key>_other` for everything else.
 */
export function translatePlural(lang: Lang, key: PluralKey, count: number, params?: MessageParams): string {
  const dual = count === 2 && lookup(lang, `${key}_two`) !== undefined;
  const suffix = count === 1 ? '_one' : dual ? '_two' : '_other';
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
