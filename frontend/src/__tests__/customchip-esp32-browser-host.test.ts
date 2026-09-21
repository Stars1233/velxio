/**
 * A custom chip on an ESP32 board whose bridge does not host chips in a
 * backend worker takes the browser path, and that path gives it I2C and SPI
 * through the shim's surfaces.
 *
 * The OSS QEMU bridge hosts chips in its worker and has no opinion; an
 * overlay's in-browser engine answers `hostsCustomChips()` false. Before
 * this seam existed the shim's `sendPinEvent` alone decided, and a chip on
 * an in-browser engine was shipped as a sensor record nothing ever ran.
 */
import { describe, it, expect } from 'vitest';
import {
  detectSimulatorKind,
  hostsChipsInWorker,
  getI2CBus,
  ensureSpiBridge,
  getSimulatorBridges,
} from '../simulation/customChips/simulatorBridges';
import type { SPIDevice } from '../simulation/customChips/SPIBus';
import { spiChainAttach } from '../simulation/parts/spiChannel';

function esp32Shim(extra: Record<string, unknown> = {}) {
  const added: Array<{ device: unknown; bus: number }> = [];
  const spi = {
    onByte: null as ((mosi: number) => void) | null,
    completed: [] as number[],
    completeTransfer(miso: number) {
      this.completed.push(miso);
    },
  };
  return {
    added,
    spi,
    sim: {
      sendPinEvent: () => {},
      registerSensor: () => true,
      addI2CDevice: (device: unknown, bus: number) => {
        added.push({ device, bus });
      },
      spi,
      ...extra,
    },
  };
}

describe('custom chips on an ESP32 shim', () => {
  it('is an esp32 simulator whichever bridge is behind the shim', () => {
    expect(detectSimulatorKind(esp32Shim().sim)).toBe('esp32');
    expect(detectSimulatorKind(esp32Shim({ hostsCustomChips: () => false }).sim)).toBe('esp32');
  });

  it('hosts chips in the worker when the bridge has no opinion', () => {
    expect(hostsChipsInWorker(esp32Shim().sim)).toBe(true);
    expect(hostsChipsInWorker(esp32Shim({ hostsCustomChips: () => true }).sim)).toBe(true);
  });

  it('leaves chips to the browser when the bridge says it has no worker', () => {
    expect(hostsChipsInWorker(esp32Shim({ hostsCustomChips: () => false }).sim)).toBe(false);
  });

  it('treats a throwing answer as the worker path, never as a crash', () => {
    const { sim } = esp32Shim({
      hostsCustomChips: () => {
        throw new Error('bridge gone');
      },
    });
    expect(hostsChipsInWorker(sim)).toBe(true);
  });

  it('never claims a worker for a simulator that is not there', () => {
    expect(hostsChipsInWorker(null)).toBe(false);
    expect(hostsChipsInWorker(undefined)).toBe(false);
  });

  it('gives a browser-hosted chip the shim I2C bus', () => {
    const { sim, added } = esp32Shim({ hostsCustomChips: () => false });
    const bus = getI2CBus(sim, 0);
    expect(bus).not.toBeNull();
    const device = { address: 0x50 };
    bus!.addDevice(device);
    expect(added).toEqual([{ device, bus: 0 }]);
  });

  it('gives a browser-hosted chip the shim SPI adapter', () => {
    const { sim, spi } = esp32Shim({ hostsCustomChips: () => false });
    ensureSpiBridge(sim);
    expect(typeof spi.onByte).toBe('function');
    const bridges = getSimulatorBridges(sim);
    expect(bridges.spiInstalled).toBe(true);
    // No chip on the bus yet: a transfer still completes with the bus's
    // idle answer, so the engine's SPI master is never left waiting.
    spi.onByte!(0xa5);
    expect(spi.completed).toHaveLength(1);
  });

  // Issue #355: an ILI9488 touch panel went deaf the moment a Grove sensor
  // model (a custom chip) sat on the same board. The chip bridge took the SPI
  // channel for itself instead of joining the chain.
  it('shares the SPI bus with a part that attached before it', () => {
    const { sim, spi } = esp32Shim({ hostsCustomChips: () => false });
    let touchSelected = false;
    const touchHeard: number[] = [];
    spiChainAttach(spi, 'touch:tft', (mosi, next) => {
      if (touchSelected) {
        touchHeard.push(mosi);
        spi.completeTransfer(0x42);
        return;
      }
      next?.(mosi);
    });
    ensureSpiBridge(sim);

    touchSelected = true;
    spi.onByte!(0xd0);
    expect(touchHeard).toEqual([0xd0]);
    // Last answer wins on the engine: the touch panel's, not the chips' idle.
    expect(spi.completed.at(-1)).toBe(0x42);
  });

  it('answers only while one of its chips is selected', () => {
    const { sim, spi } = esp32Shim({ hostsCustomChips: () => false });
    const below: number[] = [];
    spiChainAttach(spi, 'display:tft', (mosi, next) => {
      below.push(mosi);
      spi.completeTransfer(0xff);
      next?.(mosi);
    });
    ensureSpiBridge(sim);
    let armed = false;
    const chip = {
      hasPendingTransfer: () => armed,
      transfer: (mosi: number) => mosi ^ 0xff,
    } as unknown as SPIDevice;
    getSimulatorBridges(sim).spiBus.addDevice(chip);

    spi.onByte!(0x11); // chip deselected: the byte goes on down the chain
    expect(below).toEqual([0x11]);
    armed = true;
    spi.onByte!(0x0f); // chip selected: it answers, nobody else hears it
    expect(spi.completed.at(-1)).toBe(0xf0);
    expect(below).toEqual([0x11]);
  });

  it('stays on the bus when a part below it leaves', () => {
    const { sim, spi } = esp32Shim({ hostsCustomChips: () => false });
    const leave = spiChainAttach(spi, 'touch:tft', (mosi, next) => next?.(mosi));
    ensureSpiBridge(sim);
    leave();
    let armed = true;
    getSimulatorBridges(sim).spiBus.addDevice({
      hasPendingTransfer: () => armed,
      transfer: () => 0x5a,
    } as unknown as SPIDevice);
    spi.onByte!(0x00);
    expect(spi.completed.at(-1)).toBe(0x5a);
    armed = false;
  });

  it('joins once however many chips ask for the bus', () => {
    const { sim, spi } = esp32Shim({ hostsCustomChips: () => false });
    ensureSpiBridge(sim);
    ensureSpiBridge(sim);
    ensureSpiBridge(sim);
    spi.onByte!(0x33);
    // One idle answer per byte: a second copy of the bridge would add another.
    expect(spi.completed).toEqual([0xff]);
  });
});
