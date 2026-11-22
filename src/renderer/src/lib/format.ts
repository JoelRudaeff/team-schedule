/**
 * Locale-aware formatting of dates and times for the UI.
 *
 * Clock times are always 24-hour with Latin digits ("09:30") in both languages.
 * Texts that contain a time range or a date range must be rendered left-to-right even
 * inside Hebrew text: wrap them in `<bdi dir="ltr">…</bdi>` or use the `.ltr` CSS class.
 */
import { addDays, isoToLocalNoon, minutesToHHMM } from '@shared/dates';
import type { DayIndex, IsoDate, Lang, Minutes } from '@shared/types';

/** BCP-47 locale per UI language. en-GB gives day-month order and 24-hour time. */
export function localeOf(lang: Lang): string {
  return lang === 'he' ? 'he-IL' : 'en-GB';
}

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(lang: Lang, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = lang + JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(localeOf(lang), options);
    cache.set(key, f);
  }
  return f;
}

/** "09:30" */
export function formatTime(minutes: Minutes): string {
  return minutesToHHMM(minutes);
}

/** "09:30–10:45" (en dash, no spaces). Render inside an LTR span. */
export function formatTimeRange(start: Minutes, end: Minutes): string {
  return `${minutesToHHMM(start)}–${minutesToHHMM(end)}`;
}

/** "1:30" for 90 minutes, "0:45" for 45. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** Sunday-based day name: long "Sunday" / "יום ראשון", short "Sun" / "יום א׳", narrow "S" / "א׳". */
export function dayName(day: DayIndex, lang: Lang, width: 'long' | 'short' | 'narrow' = 'long'): string {
  // 1 January 2023 was a Sunday.
  const date = new Date(2023, 0, 1 + day, 12);
  return fmt(lang, { weekday: width }).format(date);
}

/** "22 Nov" / "22 בנוב׳" */
export function formatDayMonth(date: IsoDate, lang: Lang): string {
  return fmt(lang, { day: 'numeric', month: 'short' }).format(isoToLocalNoon(date));
}

/** "22/11" in both languages (day/month, Latin digits). */
export function formatDayMonthNumeric(date: IsoDate): string {
  return `${Number(date.slice(8, 10))}/${Number(date.slice(5, 7))}`;
}

/** "22 Nov 2026" / "22 בנוב׳ 2026" */
export function formatDate(date: IsoDate, lang: Lang): string {
  return fmt(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(isoToLocalNoon(date));
}

/** "Sunday, 22 November 2026" / "יום ראשון, 22 בנובמבר 2026" */
export function formatFullDate(date: IsoDate, lang: Lang): string {
  return fmt(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(isoToLocalNoon(date));
}

/** The Sunday–Saturday range of a week: "22–28 Nov 2026", "29 Nov – 5 Dec 2026". */
export function formatWeekRange(weekStart: IsoDate, lang: Lang): string {
  const from = isoToLocalNoon(weekStart);
  const to = isoToLocalNoon(addDays(weekStart, 6));
  const f = fmt(lang, { day: 'numeric', month: 'short', year: 'numeric' });
  try {
    return f.formatRange(from, to);
  } catch {
    return `${f.format(from)} – ${f.format(to)}`;
  }
}

/** "21 Nov 2026, 14:05" for an instant (ms since epoch), in this computer's time zone. */
export function formatDateTime(epochMs: number, lang: Lang): string {
  return fmt(lang, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(epochMs));
}

/** "14:05" for an instant. */
export function formatClock(epochMs: number, lang: Lang): string {
  return fmt(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(epochMs));
}

const relCache = new Map<Lang, Intl.RelativeTimeFormat>();

/** "3 minutes ago", "yesterday", "לפני 3 דקות", "אתמול" … */
export function formatRelative(epochMs: number, lang: Lang, nowMs: number = Date.now()): string {
  let rtf = relCache.get(lang);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(localeOf(lang), { numeric: 'auto' });
    relCache.set(lang, rtf);
  }
  const diffSec = Math.round((epochMs - nowMs) / 1000);
  const abs = Math.abs(diffSec);
  const sign = diffSec < 0 ? -1 : 1;
  if (abs < 45) return rtf.format(0, 'second');
  // Each unit is used only while its ROUNDED count stays below the next unit: never "60 minutes ago".
  const minutes = Math.round(abs / 60);
  if (minutes < 60) return rtf.format(sign * minutes, 'minute');
  const hours = Math.round(abs / 3600);
  if (hours < 24) return rtf.format(sign * hours, 'hour');
  const days = Math.round(abs / 86_400);
  if (days < 30) return rtf.format(sign * days, 'day');
  const months = Math.round(days / 30);
  if (months < 12) return rtf.format(sign * months, 'month');
  return rtf.format(sign * Math.max(1, Math.round(days / 365)), 'year');
}
