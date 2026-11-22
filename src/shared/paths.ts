/**
 * Names of the data files inside the repository, and the two line patterns `git blame`
 * mapping relies on. Pure code shared by main and renderer.
 */
import { isValidIsoDate } from './dates';
import { CONFIG_PATH, WEEKS_DIR, type IsoDate } from './types';

const WEEK_PATH_RE = /^weeks\/(\d{4}-\d{2}-\d{2})\.json$/;

/** `weeks/2026-11-22.json` */
export function weekPath(weekStart: IsoDate): string {
  return `${WEEKS_DIR}/${weekStart}.json`;
}

/**
 * Inverse of {@link weekPath}; null when the path is not exactly `weeks/<valid ISO date>.json`.
 * (Whether the date is a Sunday is checked by the week parser, which reports a clear problem.)
 */
export function weekStartFromPath(path: string): IsoDate | null {
  const m = WEEK_PATH_RE.exec(path);
  if (!m) return null;
  return isValidIsoDate(m[1]) ? m[1] : null;
}

/** True for `schedule.json` and for `weeks/<valid ISO date>.json` — the only files the app ever touches. */
export function isDataPath(path: string): boolean {
  return path === CONFIG_PATH || weekStartFromPath(path) !== null;
}

const EVENT_LINE_RE = /^\s*\{"id":"((?:[^"\\]|\\.)*)"/;

/**
 * For `git blame`: the event id when `line` is an event line of a canonical week file
 * (it starts with `{"id":"…"`), otherwise null. A trailing comma or "\r" does not matter.
 */
export function eventIdOfLine(line: string): string | null {
  const m = EVENT_LINE_RE.exec(line);
  if (!m) return null;
  try {
    const id: unknown = JSON.parse(`"${m[1]}"`);
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/** For `git blame`: true when `line` is the `"title": …` line of a canonical week file. */
export function isTitleLine(line: string): boolean {
  return /^\s*"title"\s*:/.test(line);
}
