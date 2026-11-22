/** Colour helpers. Colours are stored as `#RRGGBB` (upper-case). */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Accepts `#rgb`, `rgb`, `#rrggbb`, `rrggbb` (any case). Returns `#RRGGBB` or null. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return ('#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2]).toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return ('#' + s).toUpperCase();
  return null;
}

export function hexToRgb(hex: string): Rgb {
  const n = normalizeHex(hex) ?? '#000000';
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(255, Math.max(0, Math.round(v)));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => clampByte(v).toString(16).padStart(2, '0');
  return ('#' + h(r) + h(g) + h(b)).toUpperCase();
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export const TEXT_ON_LIGHT = '#111827';
export const TEXT_ON_DARK = '#FFFFFF';

/** Text colour (dark or white) with the better contrast on the given background. */
export function contrastText(background: string): string {
  const l = relativeLuminance(background);
  const contrastWithDark = (l + 0.05) / (relativeLuminance(TEXT_ON_LIGHT) + 0.05);
  const contrastWithWhite = 1.05 / (l + 0.05);
  return contrastWithDark >= contrastWithWhite ? TEXT_ON_LIGHT : TEXT_ON_DARK;
}

/** Mixes the colour with white. amount 0 → unchanged, 1 → white. */
export function mixWithWhite(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.min(1, Math.max(0, amount));
  return rgbToHex(r + (255 - r) * a, g + (255 - g) * a, b + (255 - b) * a);
}

/** Mixes the colour with black. amount 0 → unchanged, 1 → black. */
export function mixWithBlack(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.min(1, Math.max(0, amount));
  return rgbToHex(r * (1 - a), g * (1 - a), b * (1 - a));
}

/** Colour used for events that have no subject (or whose subject was deleted). */
export const NEUTRAL_EVENT_COLOR = '#64748B';

/** Distinct, readable colours offered when the user adds a subject. */
export const DEFAULT_SUBJECT_COLORS: readonly string[] = [
  '#2563EB', // blue
  '#16A34A', // green
  '#DC2626', // red
  '#D97706', // amber
  '#7C3AED', // violet
  '#0891B2', // cyan
  '#DB2777', // pink
  '#65A30D', // lime
  '#EA580C', // orange
  '#4F46E5', // indigo
  '#0D9488', // teal
  '#B45309', // brown
];

/** First palette colour that is not in `used`; cycles when all are taken. */
export function nextPaletteColor(used: readonly string[]): string {
  const taken = new Set(used.map((c) => (normalizeHex(c) ?? c).toUpperCase()));
  const free = DEFAULT_SUBJECT_COLORS.find((c) => !taken.has(c));
  return free ?? DEFAULT_SUBJECT_COLORS[used.length % DEFAULT_SUBJECT_COLORS.length];
}
