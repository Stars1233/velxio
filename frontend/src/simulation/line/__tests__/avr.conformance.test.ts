/**
 * The line-host conformance suite against the real avr8js engine.
 *
 * The guest is driven through the ATmega328P's own I/O registers (DDRB /
 * PORTB / PINB) with avr8js's write hooks, exactly what the Arduino core's
 * pinMode / digitalWrite / digitalRead compile to. Pin 8 = PB0.
 */
import { vi } from 'vitest';
import { AVRSimulator } from '../../AVRSimulator';
import { PinManager } from '../../PinManager';
import { describeLineHostConformance, type LineRig } from './lineHostConformance';

vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});

const DDRB = 0x24;
const PORTB = 0x25;
const PINB = 0x23;
const BIT = 1 << 0; // PB0 = Arduino pin 8
/** `rjmp .-2`: one instruction that loops on itself, 2 cycles each. */
const LOOP_HEX = ':02000000FFCF30\n:00000001FF\n';

function makeRig(): LineRig {
  const pm = new PinManager();
  const sim = new AVRSimulator(pm);
  sim.loadHex(LOOP_HEX);
  const cpu = (sim as unknown as { cpu: { data: Uint8Array; writeData(a: number, v: number): void; readData(a: number): number } }).cpu;
  const readReg = (a: number) => cpu.data[a] ?? 0;
  return {
    sim,
    pads: { onPad: (p, cb) => sim.pinManager.onPadChange(p, cb), get: (p) => sim.pinManager.getPad(p) },
    pin: 8,
    otherPin: 9,
    guest: {
      modeInput(pull) {
        cpu.writeData(DDRB, readReg(DDRB) & ~BIT);
        cpu.writeData(PORTB, pull === 1 ? readReg(PORTB) | BIT : readReg(PORTB) & ~BIT);
      },
      modeOutput() {
        cpu.writeData(DDRB, readReg(DDRB) | BIT);
      },
      write(level) {
        cpu.writeData(PORTB, level ? readReg(PORTB) | BIT : readReg(PORTB) & ~BIT);
      },
      read() {
        return (cpu.readData(PINB) & BIT) !== 0;
      },
    },
    run(cycles) {
      const until = sim.getCurrentCycles() + cycles;
      while (sim.getCurrentCycles() < until) sim.step();
    },
    now: () => sim.getCurrentCycles(),
    clockHz: () => sim.getClockHz(),
  };
}

describeLineHostConformance('avr8js (Uno, pin 8)', makeRig);
