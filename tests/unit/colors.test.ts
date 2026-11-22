/** Colour helpers. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBJECT_COLORS,
  NEUTRAL_EVENT_COLOR,
  TEXT_ON_DARK,
  TEXT_ON_LIGHT,
  contrastText,
  hexToRgb,
  mixWithBlack,
  mixWithWhite,
  nextPaletteColor,
  normalizeHex,
  relativeLuminance,
  rgbToHex,
} from '@shared/colors';

/** Independent WCAG 2.x implementation to check the product code against. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('normalizeHex', () => {
  it.each([
    ['#abc', '#AABBCC'],
    ['abc', '#AABBCC'],
    ['#ABC', '#AABBCC'],
    ['#a1b2c3', '#A1B2C3'],
    ['a1b2c3', '#A1B2C3'],
    ['#A1B2C3', '#A1B2C3'],
    ['A1b2C3', '#A1B2C3'],
    ['  #fff  ', '#FFFFFF'],
    ['\t000\n', '#000000'],
    ['#09f', '#0099FF'],
    ['123456', '#123456'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    '#',
    '#1',
    '#12',
    '#1234',
    '#12345',
    '#1234567',
    '#12345678',
    '#12345g',
    '#ggg',
    '##fff',
    '# fff',
    '#ff f',
    'red',
    'rgb(1,2,3)',
    '0x123456',
    '#fff;',
  ])('rejects %j', (input) => {
    expect(normalizeHex(input)).toBeNull();
  });

  it('is idempotent', () => {
    for (const input of ['#abc', 'a1b2c3', '  #fff  ']) {
      const once = normalizeHex(input);
      expect(once).not.toBeNull();
      expect(normalizeHex(once as string)).toBe(once);
    }
  });
});

describe('hexToRgb / rgbToHex', () => {
  it('reads the channels', () => {
    expect(hexToRgb('#2563EB')).toEqual({ r: 0x25, g: 0x63, b: 0xeb });
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(hexToRgb('#ff0080')).toEqual({ r: 255, g: 0, b: 128 });
  });

  it('falls back to black for text that is not a colour', () => {
    expect(hexToRgb('nope')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('writes upper-case #RRGGBB with leading zeros', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(255, 255, 255)).toBe('#FFFFFF');
    expect(rgbToHex(1, 2, 3)).toBe('#010203');
    expect(rgbToHex(37, 99, 235)).toBe('#2563EB');
    expect(rgbToHex(171, 205, 239)).toBe('#ABCDEF');
  });

  it('clamps and rounds out-of-range channels', () => {
    expect(rgbToHex(300, -5, 12.6)).toBe('#FF000D');
    expect(rgbToHex(254.5, 0.4, 0.5)).toBe('#FF0001');
    expect(rgbToHex(NaN, Infinity, -Infinity)).toBe('#000000');
  });

  it('round trips hex -> rgb -> hex for the palette and every grey', () => {
    for (const hex of [...DEFAULT_SUBJECT_COLORS, NEUTRAL_EVENT_COLOR, TEXT_ON_DARK, TEXT_ON_LIGHT]) {
      const { r, g, b } = hexToRgb(hex);
      expect(rgbToHex(r, g, b)).toBe(hex);
    }
    for (let v = 0; v <= 255; v++) {
      const hex = rgbToHex(v, v, v);
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
      expect(hexToRgb(hex)).toEqual({ r: v, g: v, b: v });
    }
  });

  it('round trips rgb -> hex -> rgb for a spread of colours', () => {
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 85) {
          expect(hexToRgb(rgbToHex(r, g, b))).toEqual({ r, g, b });
        }
      }
    }
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
  });

  it('weights green over red over blue', () => {
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
  });

  it('matches an independent implementation', () => {
    for (const hex of [...DEFAULT_SUBJECT_COLORS, NEUTRAL_EVENT_COLOR, '#808080', '#FFFF00', '#0A0A0A']) {
      expect(relativeLuminance(hex)).toBeCloseTo(luminance(hex), 10);
    }
  });

  it('accepts the short and lower-case forms', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 10);
    expect(relativeLuminance('ff0000')).toBeCloseTo(0.2126, 4);
  });
});

describe('contrastText', () => {
  it.each([...DEFAULT_SUBJECT_COLORS])('picks the better-contrast text on %s', (background) => {
    const chosen = contrastText(background);
    const other = chosen === TEXT_ON_LIGHT ? TEXT_ON_DARK : TEXT_ON_LIGHT;
    expect([TEXT_ON_LIGHT, TEXT_ON_DARK]).toContain(chosen);
    expect(contrast(background, chosen)).toBeGreaterThanOrEqual(contrast(background, other));
    // the event text must stay readable on every offered colour (WCAG large text / UI: 3:1)
    expect(contrast(background, chosen)).toBeGreaterThanOrEqual(3);
  });

  it('dark text on white and on yellow, white text on black', () => {
    expect(contrastText('#FFFFFF')).toBe(TEXT_ON_LIGHT);
    expect(contrastText('#FFFF00')).toBe(TEXT_ON_LIGHT);
    expect(contrastText('#000000')).toBe(TEXT_ON_DARK);
  });

  it('white text on the dark text colour itself, dark text on light greys', () => {
    expect(contrastText(TEXT_ON_LIGHT)).toBe(TEXT_ON_DARK);
    expect(contrastText('#E5E7EB')).toBe(TEXT_ON_LIGHT);
    expect(contrastText(NEUTRAL_EVENT_COLOR)).toBe(
      contrast(NEUTRAL_EVENT_COLOR, TEXT_ON_LIGHT) >= contrast(NEUTRAL_EVENT_COLOR, TEXT_ON_DARK) ? TEXT_ON_LIGHT : TEXT_ON_DARK,
    );
  });

  it('is the better choice for every grey and switches exactly once', () => {
    let switches = 0;
    let previous = contrastText('#000000');
    for (let v = 0; v <= 255; v++) {
      const background = rgbToHex(v, v, v);
      const chosen = contrastText(background);
      const other = chosen === TEXT_ON_LIGHT ? TEXT_ON_DARK : TEXT_ON_LIGHT;
      expect(contrast(background, chosen)).toBeGreaterThanOrEqual(contrast(background, other) - 1e-9);
      if (chosen !== previous) switches++;
      previous = chosen;
    }
    expect(switches).toBe(1);
  });

  it('accepts un-normalised input', () => {
    expect(contrastText('fff')).toBe(TEXT_ON_LIGHT);
    expect(contrastText('#000')).toBe(TEXT_ON_DARK);
  });
});

describe('mixWithWhite / mixWithBlack', () => {
  it('amount 0 leaves the colour unchanged', () => {
    for (const hex of DEFAULT_SUBJECT_COLORS) {
      expect(mixWithWhite(hex, 0)).toBe(hex);
      expect(mixWithBlack(hex, 0)).toBe(hex);
    }
  });

  it('amount 1 gives white / black', () => {
    for (const hex of DEFAULT_SUBJECT_COLORS) {
      expect(mixWithWhite(hex, 1)).toBe('#FFFFFF');
      expect(mixWithBlack(hex, 1)).toBe('#000000');
    }
  });

  it('mixes linearly per channel', () => {
    expect(mixWithWhite('#000000', 0.5)).toBe('#808080');
    expect(mixWithBlack('#FFFFFF', 0.5)).toBe('#808080');
    expect(mixWithWhite('#FF0000', 0.5)).toBe('#FF8080');
    expect(mixWithBlack('#FF0000', 0.5)).toBe('#800000');
    expect(mixWithWhite('#204060', 0.25)).toBe(rgbToHex(0x20 + (255 - 0x20) * 0.25, 0x40 + (255 - 0x40) * 0.25, 0x60 + (255 - 0x60) * 0.25));
    expect(mixWithBlack('#204060', 0.25)).toBe('#183048');
  });

  it('clamps the amount to 0 … 1', () => {
    expect(mixWithWhite('#2563EB', -1)).toBe('#2563EB');
    expect(mixWithWhite('#2563EB', 2)).toBe('#FFFFFF');
    expect(mixWithBlack('#2563EB', -1)).toBe('#2563EB');
    expect(mixWithBlack('#2563EB', 2)).toBe('#000000');
  });

  it('white gets lighter and black gets darker, monotonically', () => {
    for (const hex of DEFAULT_SUBJECT_COLORS) {
      let lighter = relativeLuminance(hex);
      let darker = lighter;
      for (let step = 1; step <= 10; step++) {
        const l = relativeLuminance(mixWithWhite(hex, step / 10));
        const d = relativeLuminance(mixWithBlack(hex, step / 10));
        expect(l).toBeGreaterThanOrEqual(lighter);
        expect(d).toBeLessThanOrEqual(darker);
        lighter = l;
        darker = d;
      }
    }
  });

  it('accepts the short form', () => {
    expect(mixWithWhite('#000', 0.5)).toBe('#808080');
    expect(mixWithBlack('fff', 0.5)).toBe('#808080');
  });
});

describe('palette', () => {
  it('holds distinct, normalised colours', () => {
    expect(DEFAULT_SUBJECT_COLORS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(DEFAULT_SUBJECT_COLORS).size).toBe(DEFAULT_SUBJECT_COLORS.length);
    for (const hex of DEFAULT_SUBJECT_COLORS) expect(normalizeHex(hex)).toBe(hex);
    expect(normalizeHex(NEUTRAL_EVENT_COLOR)).toBe(NEUTRAL_EVENT_COLOR);
    expect(DEFAULT_SUBJECT_COLORS).not.toContain(NEUTRAL_EVENT_COLOR);
  });
});

describe('nextPaletteColor', () => {
  const P = DEFAULT_SUBJECT_COLORS;

  it('starts with the first colour', () => {
    expect(nextPaletteColor([])).toBe(P[0]);
  });

  it('walks through the palette as colours get used', () => {
    const used: string[] = [];
    for (let i = 0; i < P.length; i++) {
      const next = nextPaletteColor(used);
      expect(next).toBe(P[i]);
      used.push(next);
    }
  });

  it('fills the first gap', () => {
    expect(nextPaletteColor([P[1], P[2]])).toBe(P[0]);
    expect(nextPaletteColor([P[0], P[2]])).toBe(P[1]);
    expect(nextPaletteColor(P.filter((_, i) => i !== 5))).toBe(P[5]);
    expect(nextPaletteColor([...P].reverse().slice(0, P.length - 1))).toBe(P[0]);
  });

  it('recognises used colours in any accepted spelling', () => {
    expect(nextPaletteColor([P[0].toLowerCase()])).toBe(P[1]);
    expect(nextPaletteColor([P[0].slice(1)])).toBe(P[1]);
    expect(nextPaletteColor([` ${P[0].toLowerCase()} `, P[1]])).toBe(P[2]);
  });

  it('ignores colours that are not in the palette, and junk', () => {
    expect(nextPaletteColor(['#123456', '#FFFFFF'])).toBe(P[0]);
    expect(nextPaletteColor(['not a colour', ''])).toBe(P[0]);
    expect(nextPaletteColor(['#123456', P[0]])).toBe(P[1]);
  });

  it('cycles when every colour is taken', () => {
    expect(nextPaletteColor([...P])).toBe(P[0]);
    expect(nextPaletteColor([...P, P[0]])).toBe(P[1]);
    expect(nextPaletteColor([...P, ...P])).toBe(P[0]);
    expect(nextPaletteColor([...P, '#123456', '#654321'])).toBe(P[2]);
  });

  it('always returns a palette colour', () => {
    const used: string[] = [];
    for (let i = 0; i < 40; i++) {
      const next = nextPaletteColor(used);
      expect(P).toContain(next);
      used.push(next);
    }
    // 40 subjects spread evenly: no colour is used more than one time more often than another
    const counts = P.map((c) => used.filter((u) => u === c).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});
