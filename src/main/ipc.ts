/**
 * The main-process end of the bridge: one `ipcMain.handle` per method of
 * API_INVOKE_METHODS (channel `ts:<method>`, see @shared/api).
 *
 * Every call passes three gates before it reaches the application: it must come from
 * the main window's own page, its arguments must pass the run-time checks of
 * validate.ts, and only then the handler runs with typed arguments.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { API_INVOKE_METHODS, ipcChannel, type ApiInvokeMethod, type ScheduleApi } from '@shared/api';
import { parseApiArgs, type ApiArgs } from './validate';

type ApiResults = { [M in ApiInvokeMethod]: ReturnType<ScheduleApi[M]> };

/**
 * What answers the bridge. A mapped type over ApiInvokeMethod: whatever implements it
 * (AppController) fails to compile as soon as a bridge method has no handler.
 */
export type ApiHandlers = { [M in ApiInvokeMethod]: (...args: ApiArgs[M]) => ApiResults[M] };

function handle<M extends ApiInvokeMethod>(
  method: M,
  handlers: ApiHandlers,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle(ipcChannel(method), async (event, ...raw: unknown[]) => {
    try {
      if (!isTrustedSender(event)) throw new Error('This page may not use the application bridge');
      return await handlers[method](...parseApiArgs(method, raw));
    } catch (error) {
      // Expected failures travel as values; whatever is thrown here is a bug or a local failure (see @shared/api).
      console.error(`Bridge call "${method}" failed:`, error);
      throw error;
    }
  });
}

/**
 * Registers the handlers once, at start-up. `isTrustedSender` must be true only for
 * calls that come from the main window's own page.
 */
export function registerIpc(handlers: ApiHandlers, isTrustedSender: (event: IpcMainInvokeEvent) => boolean): void {
  for (const method of API_INVOKE_METHODS) handle(method, handlers, isTrustedSender);
}
