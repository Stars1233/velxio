/**
 * GPIO -> ADC channel for the ESP32 shim, per chip.
 *
 * `Esp32BridgeShim.adcChannelForPin` was declared TWICE in the same class
 * body. Only the later definition existed at runtime, so the per-chip map in
 * the earlier one was dead code and every QEMU-backed run fell through to the
 * classic ESP32 map. On an S3 or a C3 that meant the board's real ADC pins
 * resolved to -1 and `setAdcVoltage` returned false, so a potentiometer, a
 * joystick or a SPICE-driven analog node silently did nothing. Nothing threw.
 * esbuild warned on every single build ("Duplicate member adcChannelForPin in
 * class body") and the warning scrolled past for months.
 *
 * The map is exercised through `setAdcVoltage`, which is how the app reaches
 * it, with a stub bridge recording what channel it was handed.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Esp32BridgeShim } from '../store/useSimulatorStore';

type Recorded = { channel: number; millivolts: number };

/**
 * A bridge stub. `adcChannelForGpio` is optional on purpose: the plain
 * Esp32Bridge does not implement it, which is exactly the case that used to
 * fall through to the wrong map.
 */
function shimFor(
  boardKind: string,
  adcChannelForGpio?: (gpio: number) => number,
): { shim: { setAdcVoltage(pin: number, v: number): boolean }; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const bridge = {
    boardKind,
    setAdc: (channel: number, millivolts: number) => seen.push({ channel, millivolts }),
    ...(adcChannelForGpio ? { adcChannelForGpio } : {}),
  };
  const shim = new Esp32BridgeShim(bridge as never, {} as never) as unknown as {
    setAdcVoltage(pin: number, v: number): boolean;
  };
  return { shim, seen };
}

/** Resolve one pin: the channel it reached, or -1 when it was rejected. */
function channelFor(boardKind: string, pin: number): number {
  const { shim, seen } = shimFor(boardKind);
  return shim.setAdcVoltage(pin, 1.5) ? seen[0].channel : -1;
}

describe('Esp32BridgeShim ADC channel map', () => {
  it('is declared exactly once', () => {
    // The whole bug in one line. Two declarations type-check, build, and ship.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'store', 'useSimulatorStore.ts'),
      'utf8',
    );
    expect(src.match(/private adcChannelForPin\(/g)?.length).toBe(1);
  });

  it('maps the classic ESP32 (ADC1 = GPIO32-39)', () => {
    expect(channelFor('esp32', 36)).toBe(0);
    expect(channelFor('esp32', 39)).toBe(3);
    expect(channelFor('esp32', 32)).toBe(4);
    expect(channelFor('esp32', 35)).toBe(7);
    expect(channelFor('esp32', 1)).toBe(-1);
  });

  it('maps the ESP32-S3 family, ADC2 included', () => {
    // Every one of these returned -1 while the map was dead code.
    for (const kind of ['esp32-s3', 'xiao-esp32-s3', 'arduino-nano-esp32']) {
      expect(channelFor(kind, 1)).toBe(0);
      expect(channelFor(kind, 10)).toBe(9);
      // ADC2 = GPIO11-20 at channel index 10-19, matching the machine's
      // SENS stub. Not the same numbering as ADC1, and not optional.
      expect(channelFor(kind, 11)).toBe(10);
      expect(channelFor(kind, 20)).toBe(19);
      expect(channelFor(kind, 21)).toBe(-1);
      // The classic map's pins are NOT ADC pins on an S3. Answering 0 here
      // is how the dead-code regression showed up: it injected onto a
      // channel the chip does not have there.
      expect(channelFor(kind, 36)).toBe(-1);
    }
  });

  it('maps the ESP32-C3 family, including ADC2_CH0 on GPIO5', () => {
    for (const kind of ['esp32-c3', 'xiao-esp32-c3', 'aitewinrobot-esp32c3-supermini']) {
      expect(channelFor(kind, 0)).toBe(0);
      expect(channelFor(kind, 4)).toBe(4);
      expect(channelFor(kind, 5)).toBe(5);
      expect(channelFor(kind, 6)).toBe(-1);
      expect(channelFor(kind, 36)).toBe(-1);
    }
  });

  it('lets a bridge that knows its chip answer instead', () => {
    // A private overlay installs a bridge that resolves the map itself,
    // because the answer can differ per BACKEND and not only per chip. That
    // bridge must win over the table here, for every pin, including ones the
    // table would have rejected.
    const { shim, seen } = shimFor('esp32', (gpio) => (gpio === 7 ? 3 : -1));
    expect(shim.setAdcVoltage(7, 2)).toBe(true);
    expect(seen[0]).toEqual({ channel: 3, millivolts: 2000 });
    // 36 is channel 0 in the fallback table; the bridge says it is not an
    // ADC pin, and the bridge is the authority.
    expect(shim.setAdcVoltage(36, 1)).toBe(false);
  });

  it('converts volts to millivolts', () => {
    const { shim, seen } = shimFor('esp32');
    expect(shim.setAdcVoltage(36, 3.3)).toBe(true);
    expect(seen[0].millivolts).toBe(3300);
  });
});
