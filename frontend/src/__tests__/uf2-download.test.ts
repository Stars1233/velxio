/**
 * utils/uf2Download.ts: which boards get a .uf2, how the file is named,
 * and that the download hands the browser the decoded bytes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  boardKindHasUf2,
  downloadUf2,
  fqbnUsesUf2,
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
