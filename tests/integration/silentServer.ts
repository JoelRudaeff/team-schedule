/**
 * A "server that does not answer": it accepts every connection, reads whatever is sent and
 * never says a word. `git fetch` from its address waits until somebody stops it — which is
 * exactly what a dropped VPN or a hung file server does to the app.
 */
import { createServer, type Socket } from 'node:net';

export interface SilentServer {
  /** A `git://` address on this computer that never answers. */
  url: string;
  /** How many connections were accepted so far. */
  connections(): number;
  /** Resolves once at least `count` connections were accepted. */
  waitForConnections(count: number, withinMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startSilentServer(): Promise<SilentServer> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the silent server has no port');

  return {
    url: `git://127.0.0.1:${address.port}/team.git`,
    connections: () => accepted,
    async waitForConnections(count, withinMs = 20_000) {
      const deadline = Date.now() + withinMs;
      while (accepted < count) {
        if (Date.now() > deadline) throw new Error(`the silent server saw ${accepted} of ${count} expected connections`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
