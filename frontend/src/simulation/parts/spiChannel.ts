/**
 * `spi.onByte` is a single-listener channel, and a display is rarely alone on
 * the bus: an SD card shares SCK/MOSI/MISO on every TFT+SD project there is.
 * Whoever assigned last used to mute everyone else — dropping a microSD card
 * on the canvas turned any display black, with no wiring that could avoid it
 * (issue #343).
 *
 * So listeners chain: each one keeps the handler it found and passes the byte
 * along. Every chained listener must decide for itself whether the byte is
 * its own — a card answers only while its CS is low, as it does on the wire.
 *
 * The one thing a plain chain cannot survive is a part that re-attaches
 * without giving the channel back (the TFT decoder deliberately does not, so
 * bytes arriving while React remounts the board are not dropped). Its second
 * instance would find its own first instance and chain to it, and every byte
 * would be decoded twice — same framebuffer, address counter advanced twice
 * per pixel. Hence the owner key: attaching REPLACES any handler already in
 * the chain that belongs to the same owner.
 */

const OWNER = '__velxioSpiOwner';
const PREV = '__velxioSpiPrev';

export type SpiByteHandler = (byte: number) => void;
type Chained = SpiByteHandler & { [OWNER]?: string; [PREV]?: SpiByteHandler | null };

/**
 * The handler a new listener owned by `owner` should chain to: whatever is on
 * the channel now, with any earlier incarnation of `owner` spliced out.
 */
export function spiChainUnder(
  current: SpiByteHandler | null | undefined,
  owner: string,
): SpiByteHandler | null {
  let h = (current ?? null) as Chained | null;
  while (h && h[OWNER] === owner) h = (h[PREV] ?? null) as Chained | null;
  return h;
}

/** Tag `handler` as owned by `owner`, sitting on top of `prev`. */
export function spiChainTag(
  handler: SpiByteHandler,
  owner: string,
  prev: SpiByteHandler | null,
): SpiByteHandler {
  (handler as Chained)[OWNER] = owner;
  (handler as Chained)[PREV] = prev;
  return handler;
}
