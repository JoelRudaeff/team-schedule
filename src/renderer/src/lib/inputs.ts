/** Small rules for text and number boxes. Pure code, so they can be tested without a window. */

/**
 * Direction of a box for free text: the text's own once something is typed. An EMPTY box
 * has no text to go by and would count as left-to-right, which puts the caret and the
 * placeholder on the wrong side in Hebrew — so it simply follows the interface.
 */
export function textDirection(value: string): 'auto' | undefined {
  return value === '' ? undefined : 'auto';
}

/**
 * The whole number in `text` when it is one and lies within min…max, else null. Digits
 * only: a number box also lets "1e1" and "1.5" through, which nobody means by "week 10".
 */
export function parseWholeNumber(text: string, min?: number, max?: number): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  const inRange = (min === undefined || parsed >= min) && (max === undefined || parsed <= max);
  return Number.isSafeInteger(parsed) && inRange ? parsed : null;
}
