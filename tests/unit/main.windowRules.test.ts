/**
 * Tests for src/main/windowRules.ts: where a remembered window may be put back, and which
 * page loads stay inside the app.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, isAppUrl, restorableBounds, type Rect } from '../../src/main/windowRules';

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
/** A second monitor to the left of the primary one. */
const LEFT: Rect = { x: -1920, y: 0, width: 1920, height: 1040 };
/** A second monitor to the right, set a little lower. */
const RIGHT: Rect = { x: 1920, y: 200, width: 2560, height: 1400 };

const W = 1360;
const H = 860;

describe('restorableBounds', () => {
  it('has a default size that is not below the minimum', () => {
    expect(DEFAULT_WINDOW_SIZE.width).toBeGreaterThanOrEqual(MIN_WINDOW_SIZE.width);
    expect(DEFAULT_WINDOW_SIZE.height).toBeGreaterThanOrEqual(MIN_WINDOW_SIZE.height);
  });

  it('returns null when nothing was remembered', () => {
    expect(restorableBounds(null, [PRIMARY])).toBeNull();
  });

  it('returns null when there is no display at all', () => {
    expect(restorableBounds({ x: 10, y: 10, width: W, height: H }, [])).toBeNull();
  });

  it('keeps a window that lies on the screen exactly as it was', () => {
    const saved = { x: 100, y: 80, width: W, height: H };
    expect(restorableBounds(saved, [PRIMARY])).toEqual(saved);
  });

  it('does not change the object it was given', () => {
    const saved = Object.freeze({ x: 100, y: 80, width: 300, height: 200 });
    expect(restorableBounds(saved, [PRIMARY])).not.toBe(saved);
    expect(saved).toEqual({ x: 100, y: 80, width: 300, height: 200 });
  });

  it('gives up a window that was on a monitor which is gone now', () => {
    const saved = { x: 2500, y: 300, width: W, height: H };
    expect(restorableBounds(saved, [PRIMARY, RIGHT])).toEqual(saved);
    expect(restorableBounds(saved, [PRIMARY])).toBeNull();
  });

  it('gives up a window far above or below every display', () => {
    expect(restorableBounds({ x: 100, y: -900, width: W, height: H }, [PRIMARY])).toBeNull();
    expect(restorableBounds({ x: 100, y: 5000, width: W, height: H }, [PRIMARY])).toBeNull();
  });

  describe('a partly visible title bar', () => {
    it('needs 120 pixels of it on the right edge of a display', () => {
      expect(restorableBounds({ x: 1920 - 120, y: 50, width: W, height: H }, [PRIMARY])).not.toBeNull();
      expect(restorableBounds({ x: 1920 - 119, y: 50, width: W, height: H }, [PRIMARY])).toBeNull();
    });

    it('needs 120 pixels of it on the left edge of a display', () => {
      expect(restorableBounds({ x: 120 - W, y: 50, width: W, height: H }, [PRIMARY])).not.toBeNull();
      expect(restorableBounds({ x: 119 - W, y: 50, width: W, height: H }, [PRIMARY])).toBeNull();
    });

    it('accepts the invisible resize border of a snapped window above the top edge, but no more', () => {
      expect(restorableBounds({ x: -8, y: -8, width: W, height: H }, [PRIMARY])).not.toBeNull();
      expect(restorableBounds({ x: 100, y: -16, width: W, height: H }, [PRIMARY])).not.toBeNull();
      expect(restorableBounds({ x: 100, y: -17, width: W, height: H }, [PRIMARY])).toBeNull();
    });

    it('needs the whole height of the title bar above the bottom edge', () => {
      expect(restorableBounds({ x: 100, y: 1040 - 32, width: W, height: H }, [PRIMARY])).not.toBeNull();
      expect(restorableBounds({ x: 100, y: 1040 - 31, width: W, height: H }, [PRIMARY])).toBeNull();
    });

    it('does not add up slivers on two displays: one display must show enough', () => {
      // 100 px on the primary display, the rest on the right one (which starts lower, at y = 200).
      const straddling = { x: 1820, y: 50, width: W, height: H };
      expect(restorableBounds(straddling, [PRIMARY])).toBeNull();
      // On the right display the title bar would be above its top edge.
      expect(restorableBounds(straddling, [PRIMARY, RIGHT])).toBeNull();
      expect(restorableBounds({ ...straddling, y: 300 }, [PRIMARY, RIGHT])).toEqual({ ...straddling, y: 300 });
    });

    it('needs width and height on the same display', () => {
      // Horizontally on the primary display, vertically only within the right one.
      expect(restorableBounds({ x: 100, y: 1200, width: W, height: H }, [PRIMARY, RIGHT])).toBeNull();
    });
  });

  describe('a window smaller than the minimum size', () => {
    it('is enlarged to the minimum, keeping its corner', () => {
      expect(restorableBounds({ x: 100, y: 80, width: 300, height: 200 }, [PRIMARY])).toEqual({
        x: 100,
        y: 80,
        width: MIN_WINDOW_SIZE.width,
        height: MIN_WINDOW_SIZE.height,
      });
    });

    it('enlarges each side on its own', () => {
      expect(restorableBounds({ x: 0, y: 0, width: 2000, height: 10 }, [PRIMARY])).toEqual({
        x: 0,
        y: 0,
        width: 2000,
        height: MIN_WINDOW_SIZE.height,
      });
      expect(restorableBounds({ x: 0, y: 0, width: 10, height: 900 }, [PRIMARY])).toEqual({
        x: 0,
        y: 0,
        width: MIN_WINDOW_SIZE.width,
        height: 900,
      });
    });

    it('is still given up when it lies off every display', () => {
      expect(restorableBounds({ x: 4000, y: 80, width: 300, height: 200 }, [PRIMARY])).toBeNull();
    });
  });

  describe('negative coordinates on a second monitor to the left', () => {
    const saved = { x: -1800, y: 50, width: W, height: H };

    it('are kept while that monitor is there', () => {
      expect(restorableBounds(saved, [PRIMARY, LEFT])).toEqual(saved);
      expect(restorableBounds(saved, [LEFT, PRIMARY])).toEqual(saved);
    });

    it('are given up when that monitor is gone', () => {
      expect(restorableBounds(saved, [PRIMARY])).toBeNull();
    });

    it('are kept when enough of the window reaches into the primary display', () => {
      // Right edge at x = 200: 200 px of title bar on the primary display.
      expect(restorableBounds({ x: 200 - W, y: 50, width: W, height: H }, [PRIMARY])).not.toBeNull();
    });

    it('work for a monitor above the primary one as well', () => {
      const above: Rect = { x: 0, y: -1080, width: 1920, height: 1040 };
      const there = { x: 100, y: -1000, width: W, height: H };
      expect(restorableBounds(there, [PRIMARY, above])).toEqual(there);
      expect(restorableBounds(there, [PRIMARY])).toBeNull();
    });
  });
});

describe('isAppUrl', () => {
  const APP = 'file:///C:/Program%20Files/Team%20Schedule/resources/app/out/renderer/index.html';

  it('accepts the very same address', () => {
    expect(isAppUrl(APP, APP)).toBe(true);
  });

  it('accepts the same file with another drive-letter case', () => {
    expect(isAppUrl(APP.replace('C:', 'c:'), APP)).toBe(true);
    expect(isAppUrl(APP, APP.replace('C:', 'c:'))).toBe(true);
  });

  it('accepts the same file whatever the case of its folders (Windows ignores it)', () => {
    expect(isAppUrl(APP.toLowerCase(), APP)).toBe(true);
  });

  it('accepts the same file with different escaping', () => {
    expect(isAppUrl('file:///C:/Program Files/Team Schedule/resources/app/out/renderer/index.html', APP)).toBe(true);
    expect(isAppUrl(APP.replace('index', '%69ndex'), APP)).toBe(true);
    const hebrew = 'file:///C:/Users/דנה/app/index.html';
    expect(isAppUrl('file:///C:/Users/%D7%93%D7%A0%D7%94/app/index.html', hebrew)).toBe(true);
  });

  it('accepts a reload with a query or a fragment', () => {
    expect(isAppUrl(`${APP}#/week/2026-11-22`, APP)).toBe(true);
    expect(isAppUrl(`${APP}?lang=he`, APP)).toBe(true);
  });

  it('accepts a path that only spells the same file with dot segments', () => {
    expect(isAppUrl(APP.replace('renderer/', 'renderer/../renderer/'), APP)).toBe(true);
  });

  it('rejects another file', () => {
    expect(isAppUrl(APP.replace('index.html', 'other.html'), APP)).toBe(false);
    expect(isAppUrl('file:///C:/Users/dana/Desktop/dropped.html', APP)).toBe(false);
    expect(isAppUrl(APP.replace('/renderer/index.html', '/renderer/'), APP)).toBe(false);
    expect(isAppUrl(`${APP}/index.html`, APP)).toBe(false);
    expect(isAppUrl(APP.replace('C:', 'D:'), APP)).toBe(false);
  });

  it('rejects the same path on another computer (a file URL with a host)', () => {
    expect(isAppUrl(APP.replace('file:///', 'file://fileserver/'), APP)).toBe(false);
  });

  it('rejects a web page when the app is a file, and a file when the app is the dev server', () => {
    expect(isAppUrl('http://localhost:5173/', APP)).toBe(false);
    expect(isAppUrl('https://example.com/index.html', APP)).toBe(false);
    expect(isAppUrl(APP, 'http://localhost:5173/')).toBe(false);
  });

  describe('with the development server', () => {
    const DEV = 'http://localhost:5173/';

    it('accepts anything the server serves', () => {
      expect(isAppUrl(DEV, DEV)).toBe(true);
      expect(isAppUrl('http://localhost:5173', DEV)).toBe(true);
      expect(isAppUrl('http://localhost:5173/index.html?x=1#top', DEV)).toBe(true);
      expect(isAppUrl('http://localhost:5173/src/deep/page.html', DEV)).toBe(true);
      expect(isAppUrl('HTTP://LOCALHOST:5173/', DEV)).toBe(true);
    });

    it('rejects another port, host or protocol', () => {
      expect(isAppUrl('http://localhost:5174/', DEV)).toBe(false);
      expect(isAppUrl('http://localhost/', DEV)).toBe(false);
      expect(isAppUrl('http://127.0.0.1:5173/', DEV)).toBe(false);
      expect(isAppUrl('https://localhost:5173/', DEV)).toBe(false);
      expect(isAppUrl('http://localhost.evil.example:5173/', DEV)).toBe(false);
      expect(isAppUrl('http://localhost:5173@evil.example/', DEV)).toBe(false);
      expect(isAppUrl('http://evil.example/?http://localhost:5173/', DEV)).toBe(false);
    });
  });

  it('rejects other schemes', () => {
    expect(isAppUrl('javascript:alert(1)', APP)).toBe(false);
    expect(isAppUrl('data:text/html,<p>hi</p>', APP)).toBe(false);
    expect(isAppUrl('about:blank', APP)).toBe(false);
    expect(isAppUrl('mailto:someone@example.com', APP)).toBe(false);
  });

  it('rejects garbage instead of throwing', () => {
    expect(isAppUrl('', APP)).toBe(false);
    expect(isAppUrl('not a url', APP)).toBe(false);
    expect(isAppUrl('C:\\Program Files\\Team Schedule\\index.html', APP)).toBe(false);
    expect(isAppUrl(APP, '')).toBe(false);
    expect(isAppUrl(APP, 'garbage')).toBe(false);
  });

  it('rejects a file path with a broken escape sequence instead of throwing', () => {
    expect(isAppUrl('file:///C:/app/%E0%A4%A/index.html', APP)).toBe(false);
    expect(isAppUrl('file:///C:/app/100%/index.html', APP)).toBe(false);
  });
});
