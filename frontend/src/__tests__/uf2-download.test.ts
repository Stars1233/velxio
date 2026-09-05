/**
 * utils/uf2Download.ts: which boards get a .uf2, how the file is named,
 * and that the download hands the browser the decoded bytes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  boardKindHasUf2,
  canSaveToDrive,
  downloadUf2,
  fqbnUsesUf2,
  NotBootselDriveError,
  saveUf2ToDrive,
  uf2FileName,
} from '../utils/uf2Download';

describe('fqbnUsesUf2 / boardKindHasUf2', () => {
  it('is the rp2040 core and nothing else', () => {
    expect(fqbnUsesUf2('rp2040:rp2040:rpipico')).toBe(true);
    expect(fqbnUsesUf2('rp2040:rp2040:rpipico2w:arch=riscv')).toBe(true);
    expect(fqbnUsesUf2('arduino:avr:uno')).toBe(false);
    expect(fqbnUsesUf2('esp32:esp32:esp32')).toBe(false);
    expect(fqbnUsesUf2(null)).toBe(false);
    expect(fqbnUsesUf2(undefined)).toBe(false);
  });

  it('answers per board kind through BOARD_KIND_FQBN', () => {
    expect(boardKindHasUf2('raspberry-pi-pico')).toBe(true);
    expect(boardKindHasUf2('pi-pico-w')).toBe(true);
    expect(boardKindHasUf2('arduino-uno')).toBe(false);
    expect(boardKindHasUf2('esp32')).toBe(false);
    expect(boardKindHasUf2('no-such-kind')).toBe(false);
  });
});

describe('uf2FileName', () => {
  it('uses the project name, folded to a safe stem', () => {
    expect(uf2FileName('Stellar Unicorn: the matrix!', 'stellar-unicorn')).toBe(
      'Stellar-Unicorn-the-matrix.uf2',
    );
  });
  it('falls back to the board kind when the name is empty or all junk', () => {
    expect(uf2FileName('', 'raspberry-pi-pico')).toBe('raspberry-pi-pico.uf2');
    expect(uf2FileName('   ', 'raspberry-pi-pico')).toBe('raspberry-pi-pico.uf2');
    expect(uf2FileName(null, 'pi-pico-w')).toBe('pi-pico-w.uf2');
    expect(uf2FileName('???', 'pi-pico-w')).toBe('pi-pico-w.uf2');
  });
});

describe('downloadUf2', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('decodes base64 (whitespace tolerated)', () => {
    expect(Array.from(base64ToBytes('AAEC\nAw=='))).toEqual([0, 1, 2, 3]);
  });

  it('clicks an anchor whose blob holds the decoded bytes', async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    const blobs: Blob[] = [];
    const anchor = {
      href: '',
      download: '',
      rel: '',
      click() {
        clicks.push({ href: this.href, download: this.download });
      },
      remove() {},
    };
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: () => {} },
    });
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return 'blob:fake';
      },
      revokeObjectURL: () => {},
    });
    downloadUf2('AAEC', 'sketch.uf2');
    expect(clicks).toEqual([{ href: 'blob:fake', download: 'sketch.uf2' }]);
    expect(blobs).toHaveLength(1);
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]));
  });
});

describe('saveUf2ToDrive', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  interface FakeDrive {
    name: string;
    files: Map<string, Uint8Array>;
    bootsel: boolean;
    closeThrows?: boolean;
  }

  function fakeDir(d: FakeDrive) {
    return {
      name: d.name,
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        if (name === 'INFO_UF2.TXT') {
          if (!d.bootsel) throw new DOMException('not found', 'NotFoundError');
          return {};
        }
        if (!opts?.create && !d.files.has(name)) throw new DOMException('not found', 'NotFoundError');
        return {
          async createWritable() {
            return {
              async write(data: ArrayBuffer) {
                d.files.set(name, new Uint8Array(data));
              },
              async close() {
                if (d.closeThrows) throw new DOMException('device gone', 'NetworkError');
              },
            };
          },
        };
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  it('is unavailable without the File System Access API', () => {
    vi.stubGlobal('window', {});
    expect(canSaveToDrive()).toBe(false);
  });

  it('writes the decoded file onto a BOOTSEL drive', async () => {
    const drive: FakeDrive = { name: 'RP2350', files: new Map(), bootsel: true };
    const result = await saveUf2ToDrive('AAEC', 'sketch.uf2', async () => fakeDir(drive));
    expect(result).toEqual({ drive: 'RP2350' });
    expect(Array.from(drive.files.get('sketch.uf2')!)).toEqual([0, 1, 2]);
  });

  it('treats a close() that fails after the write as success (the board rebooted)', async () => {
    const drive: FakeDrive = { name: 'RPI-RP2', files: new Map(), bootsel: true, closeThrows: true };
    await expect(saveUf2ToDrive('AAEC', 'sketch.uf2', async () => fakeDir(drive))).resolves.toEqual({ drive: 'RPI-RP2' });
    expect(drive.files.has('sketch.uf2')).toBe(true);
  });

  it('refuses a folder that is not a BOOTSEL drive, writing nothing', async () => {
    const drive: FakeDrive = { name: 'Documents', files: new Map(), bootsel: false };
    await expect(saveUf2ToDrive('AAEC', 'sketch.uf2', async () => fakeDir(drive))).rejects.toBeInstanceOf(NotBootselDriveError);
    expect(drive.files.size).toBe(0);
  });
});
