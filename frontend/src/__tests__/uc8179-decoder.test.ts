/**
 * Uc8179Decoder against the golden streams it shares with the ESP32 lane's
 * Python slave (test/fixtures/uc8179_vectors.json).
 *
 * Two facts about this controller decide whether a hand-written driver shows
 * anything, and both used to be wrong or missing here: WHICH RAM plane the
 * glass displays (0x13, never 0x10) and WHAT a set bit means (CDI DDX[0]).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Uc8179Decoder, type Uc8179Diagnostic } from '../simulation/displays/Uc8179Decoder';

interface Vector {
  name: string;
  steps: Array<{ cmd: number; data: number[] }>;
  rows: string[];
  old_plane_only: boolean;
}
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../test/fixtures/uc8179_vectors.json', import.meta.url)), 'utf8'),
) as { width: number; height: number; vectors: Vector[] };

function run(v: Vector) {
  const diagnostics: Uc8179Diagnostic[] = [];
  let last: string[] = [];
  const d = new Uc8179Decoder({
    width: fixture.width,
    height: fixture.height,
    onDiagnostic: (x) => diagnostics.push(x),
    onFlush: (frame) => {
      last = [];
      for (let y = 0; y < frame.height; y++) {
        let row = '';
        for (let x = 0; x < frame.width; x++) row += frame.pixels[y * frame.width + x] === 0 ? '#' : '.';
        last.push(row);
      }
    },
  });
  for (const step of v.steps) {
    d.feed(step.cmd, false);
    for (const b of step.data) d.feed(b, true);
  }
  return { rows: last, diagnostics };
}

describe('Uc8179Decoder golden streams', () => {
  it.each(fixture.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const { rows, diagnostics } = run(v);
    expect(rows).toEqual(v.rows);
    expect(diagnostics.at(-1)?.code === 'old-plane-only').toBe(v.old_plane_only);
  });

  it('says how much went to the wrong plane, so the message can', () => {
    const v = fixture.vectors.find((x) => x.old_plane_only)!;
    expect(run(v).diagnostics).toEqual([{ code: 'old-plane-only', oldPlaneBytes: 4 }]);
  });

  it('a reset puts the data polarity back to the register reset value', () => {
    const d = new Uc8179Decoder({ width: 8, height: 1 });
    d.feed(0x50, false);
    d.feed(0x10, true);
    expect(d.setBitIsWhite).toBe(false);
    d.reset();
    expect(d.setBitIsWhite).toBe(true);
  });
});
