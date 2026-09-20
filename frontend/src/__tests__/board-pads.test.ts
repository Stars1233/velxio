// @vitest-environment jsdom
/**
 * What the scope's channel picker is allowed to offer.
 *
 * The picker used to switch over BoardKind, so every family the switch did not
 * list got the Uno's D0-D13 / A0-A5: an STM32's PA0 and an RP2350's GP15 were
 * not offered at all, and the "D2" offered on a XIAO keyed the channel on
 * Arduino pin 2 while that pad is chip pin 10 — a channel that draws a flat
 * line on a pin that is moving. boardPads answers from the board itself, so a
 * family nobody listed still lists its own pads.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { boardPads } from '../simulation/boardPads';
import type { BoardKind } from '../types/board';

/** Mount a board element that publishes `pinInfo`, like the canvas does. */
function mountBoard(id: string, pinInfo: Array<{ name: string; x: number; y: number }>) {
  const el = document.createElement('div');
  el.id = id;
  (el as HTMLElement & { pinInfo?: unknown }).pinInfo = pinInfo;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('boardPads', () => {
  it('numbers a pad from the alias that resolves and labels it from the silkscreen', () => {
    // A XIAO publishes both names for one hole, at the same coordinates.
    mountBoard('xiao-1', [
      { name: '2', x: 7, y: 25 },
      { name: 'D0', x: 7, y: 25 },
      { name: '10', x: 7, y: 50 },
      { name: 'D2', x: 7, y: 50 },
      { name: 'GND', x: 7, y: 90 },
      { name: '3V3', x: 7, y: 103 },
    ]);
    expect(boardPads('xiao-1', 'xiao-samd21' as BoardKind)).toEqual([
      { pin: 2, label: 'D0' },
      { pin: 10, label: 'D2' },
    ]);
  });

  it('lists an STM32 by its port names', () => {
    mountBoard('bluepill-1', [
      { name: 'PA0', x: 18, y: 14 },
      { name: 'PC13', x: 18, y: 27 },
      { name: 'GND', x: 18, y: 40 },
      { name: '3V3', x: 18, y: 53 },
    ]);
    const pads = boardPads('bluepill-1', 'stm32-bluepill');
    expect(pads.map((p) => p.label)).toEqual(['PA0', 'PC13']);
    // The numbers are the linear pins the STM32 simulator reports, not a
    // renumbering of its own: PA0 = 0, PC13 = 2*16 + 13.
    expect(pads.map((p) => p.pin)).toEqual([0, 45]);
  });

  it('lists a board no table ever mentioned, by the numbers its sim reports', () => {
    mountBoard('pico2-1', [
      { name: 'GP14', x: 4, y: 10 },
      { name: 'GP15', x: 4, y: 20 },
      { name: 'GND.1', x: 4, y: 30 },
      { name: 'VBUS', x: 4, y: 40 },
    ]);
    expect(boardPads('pico2-1', 'pimoroni-pico-plus-2w' as BoardKind)).toEqual([
      { pin: 14, label: 'GP14' },
      { pin: 15, label: 'GP15' },
    ]);
  });

  it('keeps one entry per pin when a board exposes the same GPIO twice', () => {
    // An Uno breaks A4/A5 out again on its I2C header.
    mountBoard('uno-1', [
      { name: 'A4', x: 10, y: 10 },
      { name: 'A5', x: 20, y: 10 },
      { name: 'A4', x: 30, y: 10 },
      { name: 'A5', x: 40, y: 10 },
    ]);
    expect(boardPads('uno-1', 'arduino-uno')).toEqual([
      { pin: 18, label: 'A4' },
      { pin: 19, label: 'A5' },
    ]);
  });

  it('says nothing when the board is not on the canvas, so the caller can fall back', () => {
    expect(boardPads('missing', 'arduino-uno')).toEqual([]);
  });
});
