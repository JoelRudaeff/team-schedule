/**
 * The window-close protocol (see `onCloseRequested` in @shared/api), without any Electron
 * in it so the timing rules are unit-tested (tests/unit/main.closeGuard.test.ts).
 *
 *   user closes the window ──► the renderer is asked ──► it must acknowledge within 3 s
 *        no acknowledgement ──► the window is closed by force (a broken renderer must
 *                               never make the app unclosable)
 *        acknowledged ────────► the renderer decides: closeWindow() approves and closes;
 *                               otherwise the window stays open and the next attempt
 *                               starts over
 */

export const CLOSE_ACK_TIMEOUT_MS = 3000;

export interface CloseGuardHooks {
  /** Tell the renderer that the user wants to close. Return false when there is no renderer to tell. */
  ask(): boolean;
  /** Close the window without asking anyone. */
  force(): void;
}

export class CloseGuard {
  private readonly hooks: CloseGuardHooks;
  private readonly ackTimeoutMs: number;
  private approved = false;
  /** Runs while a question to the renderer is unanswered. */
  private ackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hooks: CloseGuardHooks, ackTimeoutMs: number = CLOSE_ACK_TIMEOUT_MS) {
    this.hooks = hooks;
    this.ackTimeoutMs = ackTimeoutMs;
  }

  /**
   * For the window's `close` event: true = let it close, false = cancel this attempt
   * (the renderer has been asked and now has the say).
   */
  allowClose(): boolean {
    if (this.approved) return true;
    // A second click on the close button while the first question is still open changes nothing.
    if (this.ackTimer !== null) return false;
    if (!this.hooks.ask()) {
      this.approved = true;
      return true;
    }
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.approved = true;
      this.hooks.force();
    }, this.ackTimeoutMs);
    return false;
  }

  /** The renderer got the question: from here on it decides, however long that takes. */
  acknowledge(): void {
    this.stopTimer();
  }

  /** The renderer agreed to close (or asked for it itself): the next `close` event goes through. */
  approve(): void {
    this.approved = true;
    this.stopTimer();
  }

  /** The window is gone: nothing may fire any more. */
  dispose(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.ackTimer === null) return;
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }
}
