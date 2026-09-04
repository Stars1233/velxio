/**
 * UF2 download helpers for RP2040 / RP2350 boards.
 *
 * Every Pico-family board ships a bootloader that mounts as a USB drive
 * (RPI-RP2 on RP2040, RP2350 on RP2350) when BOOTSEL is held at plug-in;
 * dropping a .uf2 on that drive programs the chip. That path needs no
 * driver, no Web Serial and no WebUSB, so it is the one route that works
 * in every browser. The compile endpoint returns the .uf2 picotool built
 * (`CompileResult.uf2_content`, stored as `BoardInstance.compiledUf2`);
 * these helpers turn it into a file the user can save.
 */

import { BOARD_KIND_FQBN } from '../types/board';

/** Whether arduino-cli programs this FQBN with a .uf2 (the rp2040 core). */
export function fqbnUsesUf2(fqbn: string | null | undefined): boolean {
  return !!fqbn && fqbn.startsWith('rp2040:rp2040:');
}

/** Whether boards of this kind produce a .uf2 the user can copy by hand. */
export function boardKindHasUf2(boardKind: string): boolean {
  return fqbnUsesUf2((BOARD_KIND_FQBN as Record<string, string | null>)[boardKind]);
}

/** Decode the base64 the compile endpoint returns. */
export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * A safe file name for the download: the project (or board) name with
 * anything outside [A-Za-z0-9._-] folded to '-', plus the .uf2 extension.
 */
export function uf2FileName(base: string | null | undefined, fallback: string): string {
  const stem = (base && base.trim()) || fallback;
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
  return `${safe}.uf2`;
}

/**
 * Hand the .uf2 to the browser as a download. Uses a transient object URL
 * on an anchor click; the URL is revoked once the click has been dispatched.
 */
export function downloadUf2(uf2Base64: string, fileName: string): void {
  const bytes = base64ToBytes(uf2Base64);
  // base64ToBytes allocates its own ArrayBuffer, so the whole buffer IS
  // the file (a Uint8Array<ArrayBufferLike> is not a BlobPart to TS 5.7+).
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: some browsers start the download after the
  // click handler returns and need the URL alive until then.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
