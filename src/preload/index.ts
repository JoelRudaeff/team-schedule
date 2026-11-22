/**
 * The only door between the sandboxed page and the main process: `window.api`
 * (ScheduleApi in @shared/api). Every method is forwarded as one IPC call; nothing else
 * from Node or Electron is exposed to the page.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { API_INVOKE_METHODS, CLOSE_REQUESTED_CHANNEL, ipcChannel, type ScheduleApi } from '@shared/api';

type Forwarder = (...args: unknown[]) => Promise<unknown>;

const forwarders: Record<string, Forwarder> = {};
for (const method of API_INVOKE_METHODS) {
  const channel = ipcChannel(method);
  forwarders[method] = (...args) => ipcRenderer.invoke(channel, ...args);
}

const api = {
  ...forwarders,
  onCloseRequested(listener: () => void): () => void {
    const handler = (): void => listener();
    ipcRenderer.on(CLOSE_REQUESTED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(CLOSE_REQUESTED_CHANNEL, handler);
    };
  },
} as unknown as ScheduleApi;

contextBridge.exposeInMainWorld('api', api);
