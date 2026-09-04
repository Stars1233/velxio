/**
 * The line-host conformance suite — what every board that declares
 * `mode: 'local'` has to pass, driven through its REAL engine at the register
 * level so nothing about the guest is mocked.
 *
 * Each case is a bug that actually shipped:
 *
 *   1. RELEASE IS OBSERVED    the RP2040 early return (ed132afb), the RP2350 listener
 *   2. PLAIN-INPUT RELEASE    AVR saw pinMode(INPUT_PULLUP) only because PORT moved
 *   3. ASSERT WITHOUT A LEVEL the 1-Wire reset on AVR: DDR changed, PORT did not
 *   4. EDGES LAND             a zero-width reply on boards with no scheduler
 *   5. THE GUEST'S TIME BASE  15 cm decoded as 22.5 cm from the chip-max clock
 *   6. THE PAD IS OWNED       the SPICE connector latching a DHT22's line HIGH
 *   7. A WHOLE REPLY ARRIVES  the 84 edges, and again on the NEXT start signal
 *   8. RESET FORGETS          a stale gate after a reboot
 *
 * A rig adapts one board: how the guest configures and reads its pin, and how
 * to run the guest forward. The rest is the same for every board.
 */
import { describe, expect, it } from 'vitest';
import type { LineCapable } from '../LineHost';
import type { PadEvent, PadState } from '../padEvent';
import { assertedLow, releasedLow } from '../padEvent';
import { requestLine } from '../requestLine';
import '../index';

/** Where the board's pad events can be observed: a PinManager, or an engine bridge's own bus. */
export interface PadSource {
  onPad(pin: number, cb: (e: PadEvent) => void): () => void;
  get(pin: number): Readonly<PadState>;
}

export interface LineRig {
  sim: LineCapable & { ownsPin(pin: number): boolean; reset(): void };
  pads: PadSource;
  /** The board GPIO under test. */
  pin: number;
  /** A second, unrelated GPIO. */
  otherPin: number;
  guest: {
    modeInput(pull: 0 | 1 | 2): void;
    modeOutput(): void;
    write(level: boolean): void;
    /** What digitalRead() returns on `pin`. */
    read(): boolean;
  };
  /** Run the guest forward by about this many cycles, applying due edges. */
  run(cycles: number): void;
  now(): number;
  clockHz(): number;
}

export function describeLineHostConformance(name: string, makeRig: () => LineRig): void {
  describe(`line-host conformance: ${name}`, () => {
    const collect = (rig: LineRig): PadEvent[] => {
      const events: PadEvent[] = [];
      rig.pads.onPad(rig.pin, (e) => events.push(e));
      return events;
    };

    it('1. reports the release of a line the guest held low (INPUT_PULLUP after LOW)', () => {
      const rig = makeRig();
      const events = collect(rig);
      rig.guest.modeInput(1);
      rig.guest.modeOutput();
      rig.guest.write(false);
      rig.guest.modeInput(1);
      const low = events.findIndex(assertedLow);
      expect(low, 'the start signal (drive low) was not reported').toBeGreaterThanOrEqual(0);
      const rel = events.slice(low + 1).find(releasedLow);
      expect(rel, 'the release was not reported').toBeDefined();
      expect(rel!.drive).toBe('z');
      // pinMode(INPUT_PULLUP) is two register writes on most cores (direction,
      // then pull), so the pull may arrive one event later; what must hold is
      // that the pad ends up released and pulled up.
      const pad = rig.pads.get(rig.pin);
      expect(pad.drive).toBe('z');
      expect(pad.pull).toBe(1);
      expect(pad.level).toBe(true);
    });

    it('2. reports a plain-input release too (no pull-up written)', () => {
      const rig = makeRig();
      const events = collect(rig);
      rig.guest.modeOutput();
      rig.guest.write(false);
      rig.guest.modeInput(0);
      const rel = events.find(releasedLow);
      expect(rel).toBeDefined();
      expect(rel!.drive).toBe('z');
      expect(rel!.pull).toBe(0);
    });

    it('3. reports a drive-low that moves no level (latch already zero, input -> output)', () => {
      const rig = makeRig();
      rig.guest.modeOutput();
      rig.guest.write(false);
      rig.guest.modeInput(0);
      const events = collect(rig);
      rig.guest.modeOutput(); // latch still 0: a level listener sees nothing
      expect(events.some(assertedLow)).toBe(true);
    });

    it('4. lands scheduled edges where the guest reads them, in order', () => {
      const rig = makeRig();
      rig.guest.modeInput(0);
      const hub = rig.sim.lineHub!();
      const us = (n: number) => Math.round((n * rig.clockHz()) / 1e6);
      const t0 = rig.now();
      hub.timeline.emit(
        {
          pin: rig.pin,
          edges: [
            { level: true, atCycle: t0 + us(100) },
            { level: false, atCycle: t0 + us(200) },
            { level: true, atCycle: t0 + us(300) },
          ],
        },
        t0,
      );
      rig.run(us(150) - (rig.now() - t0));
      expect(rig.guest.read()).toBe(true);
      rig.run(us(250) - (rig.now() - t0));
      expect(rig.guest.read()).toBe(false);
      rig.run(us(350) - (rig.now() - t0));
      expect(rig.guest.read()).toBe(true);
    });

    it("5. times edges in the guest's own base: a 100 us edge lands 100 us later", () => {
      const rig = makeRig();
      rig.guest.modeInput(0);
      const hub = rig.sim.lineHub!();
      const perUs = rig.clockHz() / 1e6;
      const t0 = rig.now();
      hub.timeline.emit({ pin: rig.pin, edges: [{ level: true, atCycle: t0 + Math.round(100 * perUs) }] }, t0);
      // Walk forward in small steps until the level flips; the flip must be
      // within 2% of 100 us of guest time.
      let landed = -1;
      for (let i = 0; i < 400 && landed < 0; i++) {
        rig.run(Math.max(1, Math.round(perUs)));
        if (rig.guest.read()) landed = rig.now() - t0;
      }
      expect(landed).toBeGreaterThan(0);
      expect(Math.abs(landed / perUs - 100)).toBeLessThan(2 + 1 / perUs);
    });

    it('6. owns the pads of an attached model and nothing else', () => {
      const rig = makeRig();
      const answer = requestLine(rig.sim, { sensor_type: 'dht22', pin: rig.pin });
      expect(answer.mode).toBe('local');
      expect(rig.sim.ownsPin(rig.pin)).toBe(true);
      expect(rig.sim.ownsPin(rig.otherPin)).toBe(false);
      if (answer.mode !== 'none') answer.release();
      expect(rig.sim.ownsPin(rig.pin)).toBe(false);
    });

    it('7. delivers a whole DHT22 reply to a real start signal, and again on the next one', () => {
      const rig = makeRig();
      const answer = requestLine(rig.sim, { sensor_type: 'dht22', pin: rig.pin, temperature: 28, humidity: 65 });
      expect(answer.mode).toBe('local');
      const us = (n: number) => Math.round((n * rig.clockHz()) / 1e6);
      const edgesSeen: boolean[] = [];
      const stamps: string[] = []; // "<us>:<H|L>" per edge, for the failure message
      let last = false;
      let sampleStart = 0;
      const sample = (cycles: number) => {
        const step = Math.max(1, us(2));
        sampleStart = rig.now();
        for (let done = 0; done < cycles; done += step) {
          rig.run(step);
          const v = rig.guest.read();
          if (v !== last) {
            edgesSeen.push(v);
            stamps.push(`${Math.round((rig.now() - sampleStart) / us(1))}:${v ? 'H' : 'L'}`);
            last = v;
          }
        }
      };
      const startSignal = () => {
        rig.guest.modeInput(1);
        rig.run(us(50));
        rig.guest.modeOutput();
        rig.guest.write(false);
        rig.run(us(1100));
        rig.guest.modeInput(1);
      };
      startSignal();
      // The idle level is what the pull-up makes it once the guest enabled it:
      // on a board whose released pad floats before that, reading it earlier
      // would count the pull-up itself as an edge. The reply starts 20 us later.
      last = rig.guest.read();
      expect(last).toBe(true);
      sample(us(6000));
      // 2 preamble + 80 data + 2 release edges. The first LOW is the first edge.
      expect(edgesSeen.length, `edges seen: ${edgesSeen.length} [${stamps.join(' ')}]`).toBe(84);
      expect(edgesSeen[0]).toBe(false);
      expect(edgesSeen[edgesSeen.length - 1]).toBe(true);
      expect(rig.guest.read()).toBe(true); // idles HIGH between reads

      edgesSeen.length = 0;
      startSignal();
      last = rig.guest.read();
      sample(us(6000));
      expect(edgesSeen.length, `the second read: ${edgesSeen.length} edges [${stamps.slice(-90).join(' ')}]`).toBe(84);
      if (answer.mode !== 'none') answer.release();
    });

    it('8. forgets its frames on reset', () => {
      const rig = makeRig();
      rig.guest.modeInput(0);
      const hub = rig.sim.lineHub!();
      const t0 = rig.now();
      hub.timeline.emit(
        { pin: rig.pin, edges: [{ level: true, atCycle: t0 + 1000 }, { level: false, atCycle: t0 + 2000 }, { level: true, atCycle: t0 + 3000 }] },
        t0,
      );
      expect(hub.timeline.busy).toBe(true);
      expect(hub.maySkip(t0 + 10)).toBe(false);
      rig.sim.reset();
      expect(hub.timeline.busy).toBe(false);
      expect(hub.maySkip(0)).toBe(true);
    });
  });
}
