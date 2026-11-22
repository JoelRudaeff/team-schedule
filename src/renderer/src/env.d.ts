/// <reference types="vite/client" />
import type { ScheduleApi } from '@shared/api';

declare global {
  interface Window {
    /** Exposed by the preload script (src/preload/index.ts). */
    api: ScheduleApi;
  }
}

export {};
