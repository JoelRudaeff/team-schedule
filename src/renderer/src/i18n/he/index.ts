import type { en } from '../en';
import { common } from './common';
import { event } from './event';
import { grid } from './grid';
import { settings } from './settings';
import { setup } from './setup';
import { store } from './store';
import { sync } from './sync';
import { toolbar } from './toolbar';
import { transfer } from './transfer';
import { ui } from './ui';

/** Hebrew texts. Must have exactly the keys of the English tables (checked by the compiler). */
export const he: typeof en = { common, event, grid, settings, setup, store, sync, toolbar, transfer, ui };
