/**
 * Runs asynchronous tasks strictly one after another, in the order they were queued.
 *
 * Used wherever two operations must never overlap: writes to the local settings files
 * (a later write must never be overtaken by an earlier one) and git work in the
 * repository folder (git refuses a second process while the first holds its lock).
 */
export class SerialQueue {
  /** Settles when the last queued task has finished; never rejects. */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Queues `task` behind everything queued before it and resolves or rejects with its
   * outcome. A task that fails (or throws synchronously) does not stop the tasks behind it.
   * A task must not wait for another task of the same queue: it would wait for itself.
   */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once everything queued so far has finished, whether it succeeded or not. */
  idle(): Promise<void> {
    return this.tail;
  }
}
