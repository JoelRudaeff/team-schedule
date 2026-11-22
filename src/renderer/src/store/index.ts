/**
 * Access to the application store from React components.
 *
 *   const weekStart = useApp((s) => s.weekStart);     // re-renders only when weekStart changes
 *   actions.goToRelativeWeek(1);
 *
 * Selector rule: a selector must return the same reference while the state it reads is
 * unchanged — return a primitive or a piece of state as it is (`s.working`, `s.filters`).
 * To pick several fields at once use `useAppShallow((s) => ({ a: s.a, b: s.b }))`.
 * Derive lists (filtering, sorting) with `useMemo` in the component, not inside the selector.
 */
import { useRef, useSyncExternalStore } from 'react';
import { createAppStore } from './createStore';
import type { AppActions, AppState, AppStore } from './types';

let store: AppStore | null = null;

export function getStore(): AppStore {
  if (!store) store = createAppStore(window.api);
  return store;
}

export function getState(): AppState {
  return getStore().getState();
}

/** All actions; safe to import and call from anywhere in the renderer. */
export const actions: AppActions = new Proxy({} as AppActions, {
  get(_target, prop) {
    return getStore().actions[prop as keyof AppActions];
  },
});

export function useApp<T>(selector: (state: AppState) => T): T {
  const s = getStore();
  return useSyncExternalStore(s.subscribe, () => selector(s.getState()));
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/** Like `useApp`, for selectors that build an object of several state fields. */
export function useAppShallow<T extends Record<string, unknown>>(selector: (state: AppState) => T): T {
  const cache = useRef<T | null>(null);
  return useApp((state) => {
    const next = selector(state);
    const prev = cache.current;
    if (prev && shallowEqual(prev, next)) return prev;
    cache.current = next;
    return next;
  });
}

export type * from './types';
