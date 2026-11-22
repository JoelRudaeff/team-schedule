/**
 * Decisions about the main window that need no Electron, so they are unit-tested
 * (tests/unit/main.windowRules.test.ts): where a remembered window may be put back, and
 * which page loads stay inside the app.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_SIZE = { width: 1360, height: 860 } as const;
export const MIN_WINDOW_SIZE = { width: 1024, height: 640 } as const;

/** The strip at the top of a window that must stay reachable: without it the window cannot be moved back. */
const TITLE_BAR_HEIGHT = 32;
const MIN_VISIBLE_TITLE_WIDTH = 120;
/** A snapped or maximized window legitimately sticks out of its screen by its invisible resize border. */
const EDGE_TOLERANCE = 16;

/**
 * The rectangle to open the window with, or null to let the system place a default-sized
 * one: remembered bounds are only used while enough of the title bar lies on one of
 * today's displays (a second monitor may have been unplugged since the last run).
 * `workAreas` are the usable areas of all displays.
 */
export function restorableBounds(saved: Rect | null, workAreas: readonly Rect[]): Rect | null {
  if (saved === null) return null;
  const bounds: Rect = {
    x: saved.x,
    y: saved.y,
    width: Math.max(saved.width, MIN_WINDOW_SIZE.width),
    height: Math.max(saved.height, MIN_WINDOW_SIZE.height),
  };
  const reachable = workAreas.some((area) => {
    const visibleWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const titleFitsVertically = bounds.y >= area.y - EDGE_TOLERANCE && bounds.y + TITLE_BAR_HEIGHT <= area.y + area.height;
    return visibleWidth >= MIN_VISIBLE_TITLE_WIDTH && titleFitsVertically;
  });
  return reachable ? bounds : null;
}

/** File URLs spell the same file in more than one way (drive-letter case, which characters are escaped). */
function filePathOf(url: URL): string {
  return decodeURIComponent(url.pathname).toLowerCase();
}

/**
 * True when loading `target` keeps the window inside the app: the app's own page again
 * (a reload) — for a built app exactly its index.html, for the development server
 * anything it serves. Everything else (a link, a file dropped on the window) is "away".
 */
export function isAppUrl(target: string, appUrl: string): boolean {
  try {
    const to = new URL(target);
    const app = new URL(appUrl);
    if (to.protocol !== app.protocol || to.host !== app.host) return false;
    return app.protocol !== 'file:' || filePathOf(to) === filePathOf(app);
  } catch {
    // Not a URL, or a path with a broken escape sequence: certainly not our page.
    return false;
  }
}
