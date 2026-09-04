import { describe, expect, it } from 'vitest';
import {
  assertedHigh,
  assertedLow,
  INITIAL_PAD,
  releasedLow,
  restingLevel,
  wentHiZ,
  type PadEvent,
  type PadState,
} from '../padEvent';
import { PinManager } from '../../PinManager';

const ev = (prev: Partial<PadState>, next: Partial<PadState>): PadEvent => ({
  pin: 1,
  ...INITIAL_PAD,
  ...next,
  prev: { ...INITIAL_PAD, ...prev },
});

describe('padEvent predicates', () => {
  it('releasedLow covers both release idioms and nothing else', () => {
    expect(releasedLow(ev({ drive: 'low' }, { drive: 'z' }))).toBe(true); // push-pull: to input
    expect(releasedLow(ev({ drive: 'low' }, { drive: 'high' }))).toBe(true); // open-drain: write a one
    expect(releasedLow(ev({ drive: 'high' }, { drive: 'z' }))).toBe(false);
    expect(releasedLow(ev({ drive: 'z' }, { drive: 'z', pull: 1 }))).toBe(false); // a pull change
  });

  it('assertedLow includes the level-less case (latch already zero, input -> output)', () => {
    expect(assertedLow(ev({ drive: 'z' }, { drive: 'low' }))).toBe(true);
    expect(assertedLow(ev({ drive: 'high' }, { drive: 'low' }))).toBe(true);
    expect(assertedLow(ev({ drive: 'low' }, { drive: 'low', pull: 1 }))).toBe(false);
  });

  it('assertedHigh and wentHiZ', () => {
    expect(assertedHigh(ev({ drive: 'low' }, { drive: 'high' }))).toBe(true);
    expect(assertedHigh(ev({ drive: 'high' }, { drive: 'high' }))).toBe(false);
    expect(wentHiZ(ev({ drive: 'high' }, { drive: 'z' }))).toBe(true);
    expect(wentHiZ(ev({ drive: 'z' }, { drive: 'z' }))).toBe(false);
  });

  it('restingLevel: the driver, else the pull, else the previous level', () => {
    expect(restingLevel('high', 2, false)).toBe(true);
    expect(restingLevel('low', 1, true)).toBe(false);
    expect(restingLevel('z', 1, false)).toBe(true);
    expect(restingLevel('z', 2, true)).toBe(false);
    expect(restingLevel('z', 0, true)).toBe(true);
    expect(restingLevel('z', 0, false)).toBe(false);
  });
});

describe('PinManager pad channel', () => {
  it('fires on a change of drive or pull, with the previous state, and derives the level', () => {
    const pm = new PinManager();
    const seen: PadEvent[] = [];
    pm.onPadChange(4, (e) => seen.push(e));
    pm.reportPad(4, 'low', 0, 100);
    pm.reportPad(4, 'low', 0, 200); // repeat: silent
    pm.reportPad(4, 'z', 1, 300);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ pin: 4, drive: 'low', level: false, cycle: 100, prev: INITIAL_PAD });
    expect(seen[1]).toMatchObject({ drive: 'z', pull: 1, level: true, cycle: 300, prev: { drive: 'low' } });
    expect(pm.getPad(4)).toMatchObject({ drive: 'z', pull: 1, level: true });
    expect(pm.getPad(5)).toBe(INITIAL_PAD);
  });

  it('does not double-fire the level channel: reportPad leaves onPinChange alone', () => {
    const pm = new PinManager();
    const levels: boolean[] = [];
    pm.onPinChange(4, (_p, s) => levels.push(s));
    pm.reportPad(4, 'high', 0, 1);
    expect(levels).toEqual([]);
  });

  it('updatePort with a DDR mask reports each bit\'s drive, including a DDR-only release', () => {
    const pm = new PinManager();
    const seen: PadEvent[] = [];
    pm.onPadChange(8, (e) => seen.push(e)); // PORTB bit 0
    pm.updatePort('PORTB', 0b0000_0001, 0, undefined, 0b0000_0001, 10); // DDR=1, PORT=1: high
    pm.updatePort('PORTB', 0b0000_0000, 1, undefined, 0b0000_0001, 20); // low
    pm.updatePort('PORTB', 0b0000_0000, 0, undefined, 0b0000_0000, 30); // DDR cleared, PORT same: released
    pm.updatePort('PORTB', 0b0000_0001, 0, undefined, 0b0000_0000, 40); // pull-up on
    expect(seen.map((e) => [e.drive, e.pull, e.cycle])).toEqual([
      ['high', 0, 10],
      ['low', 0, 20],
      ['z', 0, 30],
      ['z', 1, 40],
    ]);
    expect(releasedLow(seen[2])).toBe(true);
  });

  it('hardResetPinStates clears the pad states so the next report is a change again', () => {
    const pm = new PinManager();
    pm.reportPad(4, 'high', 0, 1);
    pm.hardResetPinStates();
    expect(pm.getPad(4)).toBe(INITIAL_PAD);
    const seen: PadEvent[] = [];
    pm.onPadChange(4, (e) => seen.push(e));
    pm.reportPad(4, 'high', 0, 2);
    expect(seen).toHaveLength(1);
  });
});
