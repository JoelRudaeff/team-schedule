/**
 * Ending a git command that waits for a server: by its time limit, and by the caller's
 * signal (which the app uses when it is closed while a check for updates is still waiting).
 * Real git against a server that accepts the connection and never answers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitError, type GitRunner } from '../../src/main/git/gitRunner';
import { createSandbox, type Sandbox } from './helpers';
import { startSilentServer, type SilentServer } from './silentServer';

async function failure(action: Promise<unknown>): Promise<GitError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof GitError) return error;
    throw error;
  }
  throw new Error('expected a GitError, but the command succeeded');
}

describe('a git command that waits for a server that never answers', () => {
  let box: Sandbox;
  let server: SilentServer;
  let git: GitRunner;

  beforeAll(async () => {
    box = await createSandbox();
    server = await startSilentServer();
    git = box.git;
  });
  afterAll(async () => {
    await server.close();
    await box.cleanup();
  });

  it('is ended by its time limit and fails with code "timeout"', async () => {
    const before = server.connections();
    const started = Date.now();
    const error = await failure(git.run(['ls-remote', server.url], { timeoutMs: 1500 }));

    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    // git really was waiting for this server, not failing for some other reason.
    expect(server.connections()).toBe(before + 1);
  });

  it('is ended by the signal, long before the time limit, and fails the same way', async () => {
    const before = server.connections();
    const stopper = new AbortController();
    const started = Date.now();
    const running = failure(git.run(['ls-remote', server.url], { timeoutMs: 120_000, signal: stopper.signal }));
    await server.waitForConnections(before + 1);

    stopper.abort();
    const error = await running;

    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('a signal that was already aborted ends the command as soon as it starts', async () => {
    const stopper = new AbortController();
    stopper.abort();
    const started = Date.now();
    const error = await failure(git.run(['ls-remote', server.url], { timeoutMs: 120_000, signal: stopper.signal }));

    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('a command that finishes by itself is not disturbed by its signal, also when that is aborted afterwards', async () => {
    const stopper = new AbortController();
    const result = await git.run(['--version'], { signal: stopper.signal });
    expect(result.stdout).toMatch(/^git version /);

    stopper.abort();
    // The runner let go of the signal: nothing is left that could still react to it.
    expect((await git.run(['--version'])).code).toBe(0);
  });
});
