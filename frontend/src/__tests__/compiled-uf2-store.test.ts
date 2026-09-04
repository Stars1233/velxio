/**
 * BoardInstance.compiledUf2 rides along with compiledProgram and dies with
 * it: RP2 boards flash from the .uf2, everything else must never carry a
 * stale one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.addI2CDevice = vi.fn();
    this.attachPioPeripheral = vi.fn();
    this.spi = { onByte: null, completeTransfer: vi.fn() };
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
    this.hardResetPinStates = vi.fn();
    this.resetPinStates = vi.fn();
  }),
}));

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

import { useSimulatorStore } from '../store/useSimulatorStore';

const boardOf = (id: string) => useSimulatorStore.getState().boards.find((b) => b.id === id)!;

describe('compiledUf2', () => {
  beforeEach(() => {
    useSimulatorStore.setState((useSimulatorStore as any).getInitialState?.() ?? {});
  });

  it('is recorded next to the program and cleared by a build without one', () => {
    const { addBoard, compileBoardProgram } = useSimulatorStore.getState();
    const id = addBoard('raspberry-pi-pico', 0, 0);
    expect(boardOf(id).compiledUf2 ?? null).toBeNull();

    compileBoardProgram(id, 'QUJD', { uf2: 'VUYy' });
    expect(boardOf(id).compiledProgram).toBe('QUJD');
    expect(boardOf(id).compiledUf2).toBe('VUYy');

    // A later build with no .uf2 (older server, another family) must not
    // leave the previous one behind.
    compileBoardProgram(id, 'REVG');
    expect(boardOf(id).compiledProgram).toBe('REVG');
    expect(boardOf(id).compiledUf2).toBeNull();
  });

  it('is dropped when the board switches language mode', () => {
    const { addBoard, compileBoardProgram, setBoardLanguageMode } = useSimulatorStore.getState();
    const id = addBoard('pi-pico-w', 0, 0);
    compileBoardProgram(id, 'QUJD', { uf2: 'VUYy' });
    setBoardLanguageMode(id, 'micropython');
    expect(boardOf(id).compiledProgram).toBeNull();
    expect(boardOf(id).compiledUf2).toBeNull();
  });
});
