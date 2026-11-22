/**
 * Tests for src/main/serialQueue.ts: strict order, no overlap, and a failing task that
 * neither stops the queue nor makes idle() reject.
 */
import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../../src/main/serialQueue';

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

describe('SerialQueue', () => {
  it('runs tasks in the order they were queued, however long each takes', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const results = await Promise.all([
      queue.run(async () => {
        await pause(30);
        log.push('slow');
        return 1;
      }),
      queue.run(async () => {
        await pause(5);
        log.push('medium');
        return 2;
      }),
      queue.run(() => {
        log.push('sync');
        return 3;
      }),
    ]);
    expect(log).toEqual(['slow', 'medium', 'sync']);
    expect(results).toEqual([1, 2, 3]);
  });

  it('never lets two tasks overlap', async () => {
    const queue = new SerialQueue();
    let running = 0;
    let mostAtOnce = 0;
    const task = async (): Promise<void> => {
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      await pause(2);
      running--;
    };
    await Promise.all(Array.from({ length: 20 }, () => queue.run(task)));
    expect(mostAtOnce).toBe(1);
  });

  it('does not start a task synchronously inside run()', async () => {
    const queue = new SerialQueue();
    let started = false;
    const done = queue.run(() => {
      started = true;
    });
    expect(started).toBe(false);
    await done;
    expect(started).toBe(true);
  });

  it('passes a rejection to its caller only and goes on with the next task', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const first = queue.run(async () => {
      log.push('first');
      throw new Error('first failed');
    });
    const second = queue.run(() => {
      log.push('second');
      return 'ok';
    });
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('ok');
    expect(log).toEqual(['first', 'second']);
  });

  it('treats a synchronous throw like a rejection', async () => {
    const queue = new SerialQueue();
    const failing = queue.run((): number => {
      throw new RangeError('thrown at once');
    });
    const after = queue.run(() => 7);
    await expect(failing).rejects.toBeInstanceOf(RangeError);
    await expect(after).resolves.toBe(7);
  });

  it('idle() resolves at once on a new queue', async () => {
    await expect(new SerialQueue().idle()).resolves.toBeUndefined();
  });

  it('idle() waits for everything queued so far and never rejects', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const failing = queue.run(async () => {
      await pause(10);
      log.push('a');
      throw new Error('boom');
    });
    failing.catch(() => undefined);
    void queue.run(async () => {
      await pause(10);
      log.push('b');
    });
    await expect(queue.idle()).resolves.toBeUndefined();
    expect(log).toEqual(['a', 'b']);
  });

  it('idle() does not wait for tasks queued after it was asked', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    void queue.run(() => {
      log.push('before');
    });
    const idle = queue.idle();
    const later = queue.run(async () => {
      await pause(20);
      log.push('after');
    });
    await idle;
    expect(log).toEqual(['before']);
    await later;
    expect(log).toEqual(['before', 'after']);
  });

  it('keeps working after many failures in a row', async () => {
    const queue = new SerialQueue();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_unused, index) =>
        queue.run(() => {
          if (index % 2 === 0) throw new Error(`no ${index}`);
          return index;
        }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(
      Array.from({ length: 10 }, (_unused, index) => (index % 2 === 0 ? 'rejected' : 'fulfilled')),
    );
    await expect(queue.run(() => 'still alive')).resolves.toBe('still alive');
  });
});
