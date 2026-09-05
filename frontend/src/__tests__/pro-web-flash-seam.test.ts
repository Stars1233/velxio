/**
 * The pro web-flash seam (lib/proWebFlash.ts) must be inert in OSS
 * builds and delegate cleanly when an overlay installs an impl.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWebFlashImpl,
  installWebFlashImpl,
  webFlashAvailable,
  webFlashMpyAvailable,
  webFlashBootloaderHint,
  webFlashHardwareRevisions,
  isNotInBootloaderError,
  NotInBootloaderError,
  type WebFlashImpl,
} from '../lib/proWebFlash';

const fakeImpl = (available: (kind: string) => boolean): WebFlashImpl => ({
  available,
  flash: vi.fn(),
});

describe('proWebFlash seam', () => {
  afterEach(() => {
    installWebFlashImpl(null);
  });

  it('is inert without an overlay (pure OSS build)', () => {
    expect(getWebFlashImpl()).toBeNull();
    expect(webFlashAvailable('esp32')).toBe(false);
    expect(webFlashAvailable('arduino-uno')).toBe(false);
  });

  it('delegates availability to the installed impl per board kind', () => {
    installWebFlashImpl(fakeImpl((kind) => kind === 'esp32'));
    expect(webFlashAvailable('esp32')).toBe(true);
    expect(webFlashAvailable('arduino-uno')).toBe(false);
  });

  it('clearing the impl restores the OSS default (hot reload)', () => {
    installWebFlashImpl(fakeImpl(() => true));
    expect(webFlashAvailable('esp32')).toBe(true);
    installWebFlashImpl(null);
    expect(webFlashAvailable('esp32')).toBe(false);
  });

  it('MicroPython availability requires the optional method AND board support', () => {
    expect(webFlashMpyAvailable('esp32')).toBe(false); // no impl
    installWebFlashImpl(fakeImpl((kind) => kind === 'esp32'));
    expect(webFlashMpyAvailable('esp32')).toBe(false); // impl without flashMicroPython
    installWebFlashImpl({
      ...fakeImpl((kind) => kind === 'esp32'),
      flashMicroPython: vi.fn(),
    });
    expect(webFlashMpyAvailable('esp32')).toBe(true);
    expect(webFlashMpyAvailable('arduino-uno')).toBe(false); // unsupported board
  });

  it('swallows a throwing available() instead of breaking the menu', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installWebFlashImpl(
      fakeImpl(() => {
        throw new Error('overlay bug');
      }),
    );
    expect(webFlashAvailable('esp32')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('has no bootloader step unless the impl declares one for the kind', () => {
    expect(webFlashBootloaderHint('raspberry-pi-pico')).toBeNull(); // no impl
    installWebFlashImpl(fakeImpl(() => true));
    expect(webFlashBootloaderHint('raspberry-pi-pico')).toBeNull(); // impl without the method
    installWebFlashImpl({
      ...fakeImpl(() => true),
      bootloaderHint: (kind) => (kind === 'raspberry-pi-pico' ? { automatic: true } : null),
    });
    expect(webFlashBootloaderHint('raspberry-pi-pico')).toEqual({ automatic: true });
    expect(webFlashBootloaderHint('esp32')).toBeNull();
  });

  it('swallows a throwing bootloaderHint() like available()', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installWebFlashImpl({
      ...fakeImpl(() => true),
      bootloaderHint: () => {
        throw new Error('overlay bug');
      },
    });
    expect(webFlashBootloaderHint('raspberry-pi-pico')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('recognises the not-in-bootloader error by class and by name', () => {
    expect(isNotInBootloaderError(new NotInBootloaderError('not in BOOTSEL'))).toBe(true);
    // A copy that crossed a module boundary keeps the name, not the prototype.
    const foreign = new Error('not in BOOTSEL');
    foreign.name = 'NotInBootloaderError';
    expect(isNotInBootloaderError(foreign)).toBe(true);
    expect(isNotInBootloaderError(new Error('port busy'))).toBe(false);
    expect(isNotInBootloaderError('nope')).toBe(false);
  });

  it('lists hardware revisions only when the impl declares more than one', () => {
    expect(webFlashHardwareRevisions('stellar-unicorn')).toBeNull(); // no impl
    installWebFlashImpl({
      ...fakeImpl(() => true),
      hardwareRevisions: (kind) =>
        kind === 'stellar-unicorn'
          ? [
              { id: 'rp2350', label: 'Pico 2 W aboard', fqbn: 'rp2040:rp2040:rpipico2w:arch=riscv' },
              { id: 'rp2040', label: 'Pico W aboard', fqbn: 'rp2040:rp2040:rpipicow' },
            ]
          : kind === 'raspberry-pi-pico'
            ? [{ id: 'only', label: 'Pico', fqbn: 'rp2040:rp2040:rpipico' }]
            : null,
    });
    expect(webFlashHardwareRevisions('stellar-unicorn')?.map((r) => r.id)).toEqual(['rp2350', 'rp2040']);
    expect(webFlashHardwareRevisions('raspberry-pi-pico')).toBeNull(); // a single entry is no choice
    expect(webFlashHardwareRevisions('esp32')).toBeNull();
  });

  it('swallows a throwing hardwareRevisions()', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installWebFlashImpl({
      ...fakeImpl(() => true),
      hardwareRevisions: () => {
        throw new Error('overlay bug');
      },
    });
    expect(webFlashHardwareRevisions('stellar-unicorn')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
