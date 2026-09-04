/**
 * The line-host conformance suite against the real rp2040js engine, plus the
 * one rule that is this board's own: its idle-spin elision is a skip taken
 * while the guest executes, so it must hold while a self-timed reply is on a
 * wire.
 *
 * The guest is driven through the RP2040's own registers — SIO OE/OUT, the
 * PADS pull bits, IO_BANK0 funcsel — exactly what the pico-sdk's gpio_* and
 * arduino-pico's pinMode / digitalWrite compile to. GPIO5 under test.
 */
import { describe, expect, it, vi } from 'vitest';
import { RP2040 } from 'rp2040js';
import { RP2040Simulator } from '../../RP2040Simulator';
import { PinManager } from '../../PinManager';
import { describeLineHostConformance, type LineRig } from './lineHostConformance';

vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});

const RAM = 0x20000000;
const NOP = 0xbf00;
const B_BACK_1 = 0xe7fd; // b .-2 : a side-effect-free spin the elision recognises
const SIO = 0xd0000000;
const GPIO_IN = SIO + 0x004;
const GPIO_OUT_SET = SIO + 0x014;
const GPIO_OUT_CLR = SIO + 0x018;
const GPIO_OE_SET = SIO + 0x024;
const GPIO_OE_CLR = SIO + 0x028;
const IO_BANK0 = 0x40014000;
const PADS_BANK0 = 0x4001c000;
const FUNCSEL_SIO = 5;
/** PADS: IE | DRIVE=4mA | SCHMITT, plus the pull bits (PUE = 8, PDE = 4). */
const PAD_BASE = 0x52;
const F_CPU = 125_000_000;

function makeRig(pin = 5): LineRig {
  const rp = new RP2040();
  [NOP, B_BACK_1].forEach((op, i) => rp.writeUint16(RAM + i * 2, op));
  rp.core.PC = RAM;
  const sim = new RP2040Simulator(new PinManager());
  // The bare core goes in directly (the loader needs a firmware image); the
  // GPIO listeners the loader would have wired are attached the same way.
  (sim as unknown as { rp2040: RP2040 }).rp2040 = rp;
  (sim as unknown as { setupGpioListeners(): void }).setupGpioListeners();
  rp.writeUint32(IO_BANK0 + 4 + 8 * pin, FUNCSEL_SIO);
  rp.writeUint32(PADS_BANK0 + 4 + 4 * pin, PAD_BASE);
  const mask = 1 << pin;
  return {
    sim,
    pin,
    otherPin: pin + 1,
    guest: {
      modeInput(pull) {
        rp.writeUint32(GPIO_OE_CLR, mask);
        rp.writeUint32(PADS_BANK0 + 4 + 4 * pin, PAD_BASE | (pull === 1 ? 8 : pull === 2 ? 4 : 0));
      },
      modeOutput() {
        rp.writeUint32(GPIO_OE_SET, mask);
      },
      write(level) {
        rp.writeUint32(level ? GPIO_OUT_SET : GPIO_OUT_CLR, mask);
      },
      read() {
        return (rp.readUint32(GPIO_IN) & mask) !== 0;
      },
    },
    run(cycles) {
      const until = sim.getCurrentCycles() + cycles;
      while (sim.getCurrentCycles() < until) sim.runFrameForTime(Math.max(0.01, (until - sim.getCurrentCycles()) / (F_CPU / 1000)));
    },
    now: () => sim.getCurrentCycles(),
    clockHz: () => sim.getClockHz(),
  };
}

describeLineHostConformance('rp2040js (Pico, GPIO5)', () => makeRig());

describe('rp2040js: the clock rule on the idle-spin elision', () => {
  it('elides the spin freely while no reply is on a wire', () => {
    const rig = makeRig();
    const { instructionsExecuted, cyclesAdvanced } = (rig.sim as RP2040Simulator).runFrameForTime(16);
    expect(cyclesAdvanced).toBeGreaterThan(1_900_000);
    expect(instructionsExecuted).toBeLessThan(5_000); // the win the elision exists for
  });

  it('does NOT elide the spin while a self-timed reply is open (the floor)', () => {
    const rig = makeRig();
    const hub = rig.sim.lineHub!();
    const t0 = rig.now();
    // A frame of the shape a counting driver reads: three edges spread over 4 ms.
    hub.timeline.emit(
      {
        pin: rig.pin,
        edges: [
          { level: true, atCycle: t0 + 125_000 },
          { level: false, atCycle: t0 + 250_000 },
          { level: true, atCycle: t0 + 500_000 },
        ],
      },
      t0,
    );
    const { instructionsExecuted } = (rig.sim as RP2040Simulator).runFrameForTime(4); // 4 ms = 500k cycles
    // Every cycle inside the open frame is executed, not skipped.
    expect(instructionsExecuted).toBeGreaterThan(200_000);
  });

  it('negative control: the same frame with selfTimed:false lets the elision run', () => {
    const rig = makeRig();
    const hub = rig.sim.lineHub!();
    const t0 = rig.now();
    hub.timeline.emit(
      {
        pin: rig.pin,
        edges: [
          { level: true, atCycle: t0 + 125_000 },
          { level: false, atCycle: t0 + 250_000 },
          { level: true, atCycle: t0 + 500_000 },
        ],
        selfTimed: false,
      },
      t0,
    );
    const { instructionsExecuted } = (rig.sim as RP2040Simulator).runFrameForTime(4);
    expect(instructionsExecuted).toBeLessThan(5_000);
  });

  it('still lands every edge of the frame while the floor holds (the fence keeps working)', () => {
    const rig = makeRig();
    rig.guest.modeInput(0);
    const hub = rig.sim.lineHub!();
    const t0 = rig.now();
    hub.timeline.emit(
      {
        pin: rig.pin,
        edges: [
          { level: true, atCycle: t0 + 125_000 },
          { level: false, atCycle: t0 + 250_000 },
          { level: true, atCycle: t0 + 500_000 },
        ],
      },
      t0,
    );
    // Sample the guest's own GPIO_IN as it runs: every edge is observed, in order.
    const seen: boolean[] = [];
    let last = rig.guest.read();
    while (rig.now() - t0 < 600_000) {
      rig.run(2_000);
      const v = rig.guest.read();
      if (v !== last) {
        seen.push(v);
        last = v;
      }
    }
    expect(seen).toEqual([true, false, true]);
  });
});
