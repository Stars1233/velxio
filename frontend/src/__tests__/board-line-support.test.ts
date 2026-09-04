import { it, expect } from 'vitest';
import {
  registerBoardLineSupport,
  getBoardLineSupport,
} from '../lib/proBoardRegistry';

it('per-kind line support: registered wins, unregistered is undefined (caller defaults)', () => {
  expect(getBoardLineSupport('unihiker-m10')).toBeUndefined();
  registerBoardLineSupport('unihiker-m10', { mode: 'hosted', models: ['dht22', 'hc-sr04'] });
  expect(getBoardLineSupport('unihiker-m10')).toEqual({ mode: 'hosted', models: ['dht22', 'hc-sr04'] });
  // A kind nobody registered stays undefined, so the Pi shim falls to its
  // own `none` default rather than a bogus support object.
  expect(getBoardLineSupport('raspberry-pi-5')).toBeUndefined();
});
