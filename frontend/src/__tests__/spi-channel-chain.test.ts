/**
 * Two devices, one `spi.onByte`.
 *
 * A TFT and an SD card share SCK/MOSI/MISO on every display project there is,
 * but the channel holds a single listener, so whoever attached last used to
 * mute the other: dropping a microSD card on the canvas turned any display
 * black (issue #343). Listeners chain now, and each decides for itself whether
 * a byte is its own.
 */
import { describe, it, expect } from 'vitest';
import { spiChainTag, spiChainUnder, type SpiByteHandler } from '../simulation/parts/spiChannel';

/** A listener that records what it is given and passes it on. */
function listener(owner: string, seen: number[], current: SpiByteHandler | null) {
  const prev = spiChainUnder(current, owner);
  const fn: SpiByteHandler = (b) => {
    seen.push(b);
    prev?.(b);
  };
  return spiChainTag(fn, owner, prev);
}

describe('the SPI byte channel', () => {
  it('lets every listener hear the bus, newest first', () => {
    const tft: number[] = [];
    const sd: number[] = [];
    let channel: SpiByteHandler | null = null;
    channel = listener('tft:panel', tft, channel);
    channel = listener('sd:card', sd, channel);
    channel(0x2c);
    expect(sd).toEqual([0x2c]);
    expect(tft, 'the display did not go deaf when the card arrived').toEqual([0x2c]);
  });

  it('replaces an earlier incarnation of the same owner instead of stacking it', () => {
    // The TFT decoder deliberately does not hand the channel back when React
    // unmounts it, so its next instance finds its own last one. Chaining to it
    // would decode every byte twice — same framebuffer, address counter
    // advanced twice per pixel.
    const first: number[] = [];
    const second: number[] = [];
    const card: number[] = [];
    let channel: SpiByteHandler | null = null;
    channel = listener('sd:card', card, channel);
    channel = listener('tft:panel', first, channel);
    channel = listener('tft:panel', second, channel); // remount
    channel(0x77);
    expect(second).toEqual([0x77]);
    expect(first, 'the stale decoder is spliced out').toEqual([]);
    expect(card, 'what was under it still hears the bus').toEqual([0x77]);
  });

  it('keeps ordinary chains untouched when nothing shares an owner', () => {
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    let ch: SpiByteHandler | null = null;
    ch = listener('a', a, ch);
    ch = listener('b', b, ch);
    ch = listener('c', c, ch);
    ch(1);
    expect([a, b, c]).toEqual([[1], [1], [1]]);
  });
});
