// @vitest-environment jsdom
/**
 * The direction the guest programmed for a pad, and what follows from it.
 *
 * Every ESP32-family bridge reports it — the engines publish `onPinDir`, the
 * QEMU worker sends `gpio_dir` — and the app used to drop it, so a pad counted
 * as an output only once the firmware TOGGLED it. Between `pinMode(pin,
 * OUTPUT)` and the first edge the pad was treated as an input: the netlist
 * stamped no V-source for it, and connectDigitalInputsToMcu pushed the solved
 * level into the guest. On an engine that models a host-held pad the way
 * silicon models a driver on the line, that is fatal — the host keeps the pad
 * and the guest's own writes never reach the wire again. That is the ESP32-P4
 * blink example: the sketch printing LED ON to an LED that stayed dark.
 */
import { describe, it, expect, vi } from 'vitest';
import { PinManager } from '../simulation/PinManager';

vi.mock('../simulation/spice/electricalResolveHook', () => ({
  requestElectricalResolve: vi.fn(),
}));

// One board, one wired pin, one solved net — the shape the input connector
// reads. Deliberately the REAL PinManager: the direction is the fact under
// test, and a stub for it would test the stub.
const boardPinManager = new PinManager();
const sim = { setPinState: vi.fn(), spiceDrivenInputs: true, ownsPin: () => false };
vi.mock('../store/useSimulatorStore', () => ({
  useSimulatorStore: {
    getState: () => ({ boards: [{ id: 'esp32-p4', boardKind: 'esp32' }] }),
    subscribe: () => () => {},
  },
  getBoardSimulator: () => sim,
  getBoardPinManager: () => boardPinManager,
}));
const electrical = {
  nodeVoltages: { n0: 0 } as Record<string, number>,
  pinNetMap: new Map<string, string>([['esp32-p4:33', 'n0']]),
  sourcedNets: new Set<string>(['n0']),
};
vi.mock('../store/useElectricalStore', () => ({
  useElectricalStore: { getState: () => electrical, subscribe: () => () => {} },
}));

const { connectDigitalInputsToMcu } = await import(
  '../simulation/spice/connectDigitalInputsToMcu'
);

describe('a pad whose direction the guest declared', () => {
  it('counts as driven from pinMode(OUTPUT), before any edge', () => {
    const pm = new PinManager();
    expect(pm.getOutputPins().has(33)).toBe(false);
    pm.setPinDirection(33, 1);
    expect(pm.getOutputPins().has(33)).toBe(true);
    expect(pm.getPinDirection(33)).toBe(1);
  });

  it('stops counting as driven when the guest releases it', () => {
    const pm = new PinManager();
    pm.setPinDirection(4, 1);
    pm.setPinDirection(4, 0);
    // A one-wire driver releases its bus by flipping the pad to an input; from
    // that moment the pull and the circuit decide it, not a V-source at
    // whatever level the output latch happened to hold.
    expect(pm.getOutputPins().has(4)).toBe(false);
    expect(pm.getPinDirection(4)).toBe(0);
  });

  it('leaves a board that never reports direction exactly as it was', () => {
    const pm = new PinManager();
    pm.triggerPinChange(9, true, 'mcu');
    expect(pm.getOutputPins().has(9)).toBe(true);
    expect(pm.getPinDirection(9)).toBeUndefined();
  });

  it('forgets directions on a cold reset, like every other pad fact', () => {
    const pm = new PinManager();
    pm.setPinDirection(33, 1);
    pm.hardResetPinStates();
    expect(pm.getOutputPins().has(33)).toBe(false);
    expect(pm.getPinDirection(33)).toBeUndefined();
  });
});

describe('the input connector and a pad the guest drives', () => {
  it('leaves the pad alone once the guest declares it an OUTPUT', () => {
    sim.setPinState.mockClear();
    // An LED and its resistor make the net component-backed, so before the
    // guest says anything the connector rightly drives the pin...
    connectDigitalInputsToMcu()();
    expect(sim.setPinState).toHaveBeenCalledWith(33, false);

    // ...and once `pinMode(33, OUTPUT)` is reported, it must stop: the pad is
    // the guest's, and a host that keeps pushing levels into it is what left
    // the P4's LED dark while the sketch was writing to it.
    sim.setPinState.mockClear();
    boardPinManager.setPinDirection(33, 1);
    electrical.nodeVoltages = { n0: 3.3 };
    connectDigitalInputsToMcu()();
    expect(sim.setPinState).not.toHaveBeenCalled();
  });
});
