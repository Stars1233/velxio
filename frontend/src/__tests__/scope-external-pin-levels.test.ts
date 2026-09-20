/**
 * The oscilloscope has to show the levels the CIRCUIT puts on a pin, not only
 * the ones the sketch drives.
 *
 * Reported by a user on an Uno: a pushbutton to GND on D12 with
 * `pinMode(12, INPUT_PULLUP)`. The sketch reacted to every press — D13's LED
 * toggled — while a scope channel on D12 sat at HIGH through all of it, on
 * every trigger mode. The cause is one seam wide: `onPinChangeWithTime`, the
 * scope's digital source, is fired from avr8js's port listeners, and those
 * fire on PORT/DDR writes. `AVRIOPort.setPin` — the door every external level
 * comes through — moves the PIN register and notifies nobody, so the scope
 * kept redrawing the level the last PORT write implied: the pull-up's HIGH.
 *
 * Same seam on the RP2040: `GPIOPin.setInputValue` notifies nobody either,
 * and an input pin's listener value is the pad's PULL, not its level.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';
import { ExternalPinScopeFeed } from '../simulation/externalPinScope';

vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});

const HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-blink/avr-blink.ino.hex', import.meta.url)),
  'utf-8',
);
/** loadBinary takes base64, the shape the compile service returns. */
const PICO_BIN = readFileSync(
  fileURLToPath(new URL('./fixtures/rp2040-blink/rp2040-blink.ino.bin', import.meta.url)),
).toString('base64');

type Sample = { pin: number; state: boolean; timeMs: number };

/** A booted Uno with the blink fixture: D13 an output, every other pin idle. */
function bootUno() {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(HEX);
  const samples: Sample[] = [];
  sim.onPinChangeWithTime = (pin, state, timeMs) => samples.push({ pin, state, timeMs });
  // Far enough for setup() to run, so DDRB says D13 is driven.
  for (let i = 0; i < 200_000; i++) sim.step();
  return { sim, samples, on: (pin: number) => samples.filter((s) => s.pin === pin) };
}

describe('external pin levels reach the oscilloscope', () => {
  it('reports a button pulling an INPUT pin to GND (the D12 report)', () => {
    const { sim, on } = bootUno();
    const before = on(12).length;

    sim.setPinState(12, false); // press
    sim.setPinState(12, true); // release

    const seen = on(12).slice(before);
    expect(seen.map((s) => s.state)).toEqual([false, true]);
    // Timestamps come off the CPU cycle counter, like every other sample on
    // this channel — a wall-clock stamp would land the edge nowhere near the
    // driven ones around it.
    expect(seen[0].timeMs).toBeGreaterThan(0);
  });

  it('does not bury the edge under the solver re-asserting the same level', () => {
    const { sim, on } = bootUno();
    const before = on(12).length;

    sim.setPinState(12, false);
    for (let i = 0; i < 50; i++) sim.setPinState(12, false); // ~20 Hz of re-solves
    expect(on(12).slice(before)).toHaveLength(1);

    sim.setPinState(12, true);
    expect(on(12).slice(before).map((s) => s.state)).toEqual([false, true]);
  });

  it('ignores an injection on a pin the sketch drives as an OUTPUT', () => {
    const { sim, samples, on } = bootUno();
    // The blink fixture owns D13; avr8js keeps driving the pad and the
    // injected value never reaches the PIN register, so the scope must not
    // draw it either.
    expect(sim.pinManager.getOutputPins().has(13)).toBe(true);
    const before = samples.length;
    sim.setPinState(13, false);
    expect(samples).toHaveLength(before);
    expect(on(13).length).toBeGreaterThan(0); // the driven edges still arrive
  });

  it('reports an external level on the RP2040 too', () => {
    const sim = new RP2040Simulator(new PinManager());
    sim.loadBinary(PICO_BIN);
    const samples: Sample[] = [];
    sim.onPinChangeWithTime = (pin, state, timeMs) => samples.push({ pin, state, timeMs });
    // GP16 is untouched by the blink fixture: a plain input, which is exactly
    // the pin that used to report nothing at all — rp2040js hands its listener
    // a pull state, never a level.
    sim.setPinState(16, true);
    sim.setPinState(16, false);
    expect(samples.filter((s) => s.pin === 16).map((s) => s.state)).toEqual([true, false]);
  });
});

describe('ExternalPinScopeFeed', () => {
  const feed = () => {
    const seen: Sample[] = [];
    let now = 0;
    const f = new ExternalPinScopeFeed(() => ++now);
    const sink = (pin: number, state: boolean, timeMs: number) => seen.push({ pin, state, timeMs });
    return { f, seen, sink };
  };

  it('reports an edge once and stamps it with the board clock', () => {
    const { f, seen, sink } = feed();
    f.emit(sink, 3, true);
    f.emit(sink, 3, true);
    expect(seen).toEqual([{ pin: 3, state: true, timeMs: 1 }]);
  });

  it('re-reports a level once the core has driven that pad', () => {
    const { f, seen, sink } = feed();
    f.emit(sink, 3, true);
    // The sketch drove the pin: whatever this door remembers is stale, so the
    // circuit putting the same level back on the pad is an edge again.
    f.forget(3);
    f.emit(sink, 3, true);
    expect(seen.map((s) => s.state)).toEqual([true, true]);
  });

  it('forgets every pad on reset, and survives a channel nobody listens to', () => {
    const { f, seen, sink } = feed();
    f.emit(sink, 3, true);
    f.reset();
    f.emit(null, 3, false); // no scope open — must not throw, and must not lie
    f.emit(sink, 3, false);
    expect(seen.map((s) => s.state)).toEqual([true]);
  });
});
