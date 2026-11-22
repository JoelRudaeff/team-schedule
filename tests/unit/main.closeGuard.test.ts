/**
 * Tests for src/main/closeGuard.ts: the timing rules of the window-close protocol.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_ACK_TIMEOUT_MS, CloseGuard } from '../../src/main/closeGuard';

function setup(hasRenderer: boolean, timeoutMs?: number) {
  const ask = vi.fn(() => hasRenderer);
  const force = vi.fn();
  const guard = timeoutMs === undefined ? new CloseGuard({ ask, force }) : new CloseGuard({ ask, force }, timeoutMs);
  return { ask, force, guard };
}

describe('CloseGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits three seconds for the acknowledgement by default', () => {
    expect(CLOSE_ACK_TIMEOUT_MS).toBe(3000);
  });

  it('closes at once when there is no renderer to ask', () => {
    const { ask, force, guard } = setup(false);
    expect(guard.allowClose()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * CLOSE_ACK_TIMEOUT_MS);
    expect(force).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // Once through, always through - and nobody is asked again.
    expect(guard.allowClose()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('cancels the attempt and asks the renderer when there is one', () => {
    const { ask, force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(force).not.toHaveBeenCalled();
  });

  it('stays open however long once the renderer acknowledged', () => {
    const { force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    vi.advanceTimersByTime(CLOSE_ACK_TIMEOUT_MS - 1);
    guard.acknowledge();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(force).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets the next close through after approve()', () => {
    const { ask, force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    guard.acknowledge();
    guard.approve();
    expect(guard.allowClose()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * CLOSE_ACK_TIMEOUT_MS);
    expect(force).not.toHaveBeenCalled();
  });

  it('approve() without an acknowledgement also stops the timer', () => {
    const { force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    guard.approve();
    expect(vi.getTimerCount()).toBe(0);
    expect(guard.allowClose()).toBe(true);
    vi.advanceTimersByTime(10 * CLOSE_ACK_TIMEOUT_MS);
    expect(force).not.toHaveBeenCalled();
  });

  it('approve() before any close attempt (the renderer closes by itself) asks nobody', () => {
    const { ask, guard } = setup(true);
    guard.approve();
    expect(guard.allowClose()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('closes by force after exactly the timeout when nobody acknowledged', () => {
    const { force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    vi.advanceTimersByTime(CLOSE_ACK_TIMEOUT_MS - 1);
    expect(force).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(force).toHaveBeenCalledTimes(1);
    // The forced close arrives as another `close` event, which must go through.
    expect(guard.allowClose()).toBe(true);
    vi.advanceTimersByTime(10 * CLOSE_ACK_TIMEOUT_MS);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('honours a custom timeout', () => {
    const { force, guard } = setup(true, 250);
    guard.allowClose();
    vi.advanceTimersByTime(249);
    expect(force).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('ignores a second close attempt while the first question is open', () => {
    const { ask, force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(guard.allowClose()).toBe(false);
    expect(guard.allowClose()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    // The clock was not restarted by the second attempt.
    vi.advanceTimersByTime(CLOSE_ACK_TIMEOUT_MS - 2000 - 1);
    expect(force).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('starts over on the next attempt when the renderer kept the window open', () => {
    const { ask, force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    guard.acknowledge();
    // The user answered "cancel" in the renderer; later the close button is clicked again.
    expect(guard.allowClose()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CLOSE_ACK_TIMEOUT_MS);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels the timer', () => {
    const { force, guard } = setup(true);
    expect(guard.allowClose()).toBe(false);
    guard.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * CLOSE_ACK_TIMEOUT_MS);
    expect(force).not.toHaveBeenCalled();
  });

  it('acknowledge(), approve() and dispose() are harmless when nothing is pending', () => {
    const { force, guard } = setup(true);
    expect(() => {
      guard.acknowledge();
      guard.dispose();
      guard.dispose();
    }).not.toThrow();
    expect(guard.allowClose()).toBe(false);
    guard.acknowledge();
    guard.acknowledge();
    vi.advanceTimersByTime(10 * CLOSE_ACK_TIMEOUT_MS);
    expect(force).not.toHaveBeenCalled();
  });

  it('a late acknowledgement after the forced close changes nothing', () => {
    const { force, guard } = setup(true);
    guard.allowClose();
    vi.advanceTimersByTime(CLOSE_ACK_TIMEOUT_MS);
    guard.acknowledge();
    expect(guard.allowClose()).toBe(true);
    expect(force).toHaveBeenCalledTimes(1);
  });
});
