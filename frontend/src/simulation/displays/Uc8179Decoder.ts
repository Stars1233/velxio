/**
 * Uc8179Decoder — UltraChip UC8179 / GD7965, the MONO controller behind the
 * 7.5" 800x480 Waveshare / GoodDisplay panels (GxEPD2_750_T7).
 *
 * Same command FAMILY as the UC8159c (0x10/0x13 DTM, 0x12 refresh) but 1 bit
 * per pixel (8 px/byte) with a partial window (0x90). GxEPD2 writes the VISIBLE
 * image to 0x13 (DTM2 "current"); 0x10 is the "previous" buffer (ignored).
 *
 * Two things a hand-written driver gets wrong, and the glass shows both:
 *
 *   - WHICH plane is displayed. In KW mode 0x10 (DTM1) is the OLD image, kept
 *     only so the waveform knows each pixel's previous state, and 0x13 (DTM2)
 *     is the NEW one. A driver that sends its picture to 0x10 alone and then
 *     refreshes gets a panel that redraws what 0x13 holds: nothing. The model
 *     does the same, and says so through `onDiagnostic` so the person is not
 *     left staring at a blank panel that "received" 48 000 bytes.
 *
 *   - WHAT a set bit means. CDI (0x50) DDX[0] chooses it: 1 = a set bit is
 *     white (GxEPD2 writes 0x29, "0xFF is white"), 0 = a set bit is BLACK
 *     (Waveshare writes 0x10 and inverts its buffer for 0x13). The reset value
 *     is DDX = 01. Polarity is applied as the bytes arrive; a driver sets CDI
 *     during init, before any image, so the simplification is invisible.
 *
 * Each image write is framed:
 *   0x91 partial-in, 0x90 window (x0/x1/y0/y1 px, MSB-first, byte-aligned x),
 *   0x13 + row-major 1bpp data, 0x92 partial-out.
 * Latches on 0x12 DISPLAY_REFRESH. `0xFF is white` per the driver, so a set bit
 * is white. Data lands at ABSOLUTE pixel coords inside the window, so compose
 * is just the RAM (no rotation, no window-union). The composed Frame reuses the
 * SSD168x palette (0=black, 1=white) so the same paintFrame() renders it.
 */

import type { Frame } from './SSD168xDecoder';

export const UC8179_CMD_POWER_OFF       = 0x02;
export const UC8179_CMD_POWER_ON        = 0x04;
export const UC8179_CMD_DEEP_SLEEP      = 0x07;
export const UC8179_CMD_DTM1            = 0x10; // previous/old buffer (ignored)
export const UC8179_CMD_DISPLAY_REFRESH = 0x12;
export const UC8179_CMD_DTM2            = 0x13; // current/new image (visible)
export const UC8179_CMD_CDI             = 0x50; // VCOM and data interval: DDX[1:0] = data polarity
export const UC8179_CMD_PARTIAL_WINDOW  = 0x90;

/** Why a refresh did not show what the driver sent, or null when it did. */
export type Uc8179Diagnostic = {
  code: 'old-plane-only';
  /** Bytes the driver wrote to 0x10 since the previous refresh. */
  oldPlaneBytes: number;
} | null;

export interface Uc8179DecoderOptions {
  width: number;
  height: number;
  onFlush?: (frame: Frame) => void;
  /** Called at every refresh: a reason when the picture cannot be on the
   *  glass, null when the refresh showed what was sent. */
  onDiagnostic?: (diagnostic: Uc8179Diagnostic) => void;
}

export class Uc8179Decoder {
  readonly width: number;
  readonly height: number;
  /** width*height palette indices (0=black, 1=white), default white. */
  ram: Uint8Array;

  private currentCmd = -1;
  private params: number[] = [];
  private activeVisible = false; // true while streaming 0x13 (DTM2)
  private winX0 = 0;
  private winX1 = 0;
  private winY0 = 0;
  private winY1 = 0;
  private cx = 0;
  private cy = 0;

  refreshedCount = 0;
  unknownCmds: number[] = [];
  inDeepSleep = false;
  /** CDI DDX[0]: true = a set bit is white. Reset value of the register. */
  setBitIsWhite = true;
  /** Image bytes received per plane since the last refresh. */
  private oldPlaneBytes = 0;
  private newPlaneBytes = 0;

  private readonly onFlush?: (frame: Frame) => void;
  private readonly onDiagnostic?: (diagnostic: Uc8179Diagnostic) => void;

  constructor(opts: Uc8179DecoderOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.ram = new Uint8Array(opts.width * opts.height).fill(1); // white
    this.winX1 = opts.width - 1;
    this.winY1 = opts.height - 1;
    this.onFlush = opts.onFlush;
    this.onDiagnostic = opts.onDiagnostic;
  }

  feed(byte: number, dcHigh: boolean): void {
    if (!dcHigh) this.beginCommand(byte & 0xff);
    else this.handleData(byte & 0xff);
  }

  reset(): void {
    this.ram.fill(1);
    this.currentCmd = -1;
    this.params = [];
    this.activeVisible = false;
    this.winX0 = 0;
    this.winX1 = this.width - 1;
    this.winY0 = 0;
    this.winY1 = this.height - 1;
    this.cx = 0;
    this.cy = 0;
    this.inDeepSleep = false;
    this.setBitIsWhite = true;
    this.oldPlaneBytes = 0;
    this.newPlaneBytes = 0;
  }

  composeFrame(): Frame {
    return { width: this.width, height: this.height, pixels: this.ram.slice() };
  }

  private beginCommand(cmd: number): void {
    this.currentCmd = cmd;
    this.params = [];
    if (cmd === UC8179_CMD_DTM2) {
      this.activeVisible = true;
      this.cx = this.winX0;
      this.cy = this.winY0;
      return;
    }
    if (cmd === UC8179_CMD_DTM1) {
      this.activeVisible = false; // old buffer — ignore its data
      return;
    }
    if (cmd === UC8179_CMD_DISPLAY_REFRESH) {
      this.refreshedCount += 1;
      // A picture sent to the OLD plane alone is a picture the controller
      // never shows. Nothing sent at all is a plain re-refresh, which is fine.
      this.onDiagnostic?.(
        this.newPlaneBytes === 0 && this.oldPlaneBytes > 0
          ? { code: 'old-plane-only', oldPlaneBytes: this.oldPlaneBytes }
          : null,
      );
      this.oldPlaneBytes = 0;
      this.newPlaneBytes = 0;
      this.onFlush?.(this.composeFrame());
      return;
    }
    // 0x90 + init commands consume data in handleData; others are no-ops.
  }

  private handleData(byte: number): void {
    const cmd = this.currentCmd;
    this.params.push(byte);
    if (cmd === UC8179_CMD_DEEP_SLEEP) {
      if (byte === 0xa5) this.inDeepSleep = true;
      return;
    }
    if (cmd === UC8179_CMD_PARTIAL_WINDOW && this.params.length === 9) {
      const p = this.params;
      this.winX0 = (p[0] << 8) | p[1];
      this.winX1 = (p[2] << 8) | p[3];
      this.winY0 = (p[4] << 8) | p[5];
      this.winY1 = (p[6] << 8) | p[7];
      return;
    }
    if (cmd === UC8179_CMD_CDI && this.params.length === 1) {
      this.setBitIsWhite = (byte & 0x01) === 0x01;
      return;
    }
    if (cmd === UC8179_CMD_DTM1) {
      this.oldPlaneBytes += 1;
      return;
    }
    if (cmd === UC8179_CMD_DTM2 && this.activeVisible) {
      this.newPlaneBytes += 1;
      this.writeImageByte(byte);
    }
  }

  private writeImageByte(byte: number): void {
    // 8 px, MSB = leftmost. What a set bit means is CDI DDX[0]'s call.
    const w = this.width;
    const white = this.setBitIsWhite;
    const cy = this.cy;
    if (cy >= 0 && cy < this.height) {
      const base = cy * w;
      for (let k = 0; k < 8; k++) {
        const x = this.cx + k;
        if (x >= this.winX0 && x <= this.winX1 && x >= 0 && x < w) {
          const set = (byte & (0x80 >> k)) !== 0;
          this.ram[base + x] = set === white ? 1 : 0;
        }
      }
    }
    this.cx += 8;
    if (this.cx > this.winX1) {
      this.cx = this.winX0;
      this.cy += 1;
    }
  }
}
