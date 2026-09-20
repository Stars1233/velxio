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
const LINK = '__velxioSpiLink';

export type SpiByteHandler = (byte: number) => void;
/** What a chained listener forwards to. Mutable, and read at call time, so a
 *  listener can be spliced out of the middle of a chain after the fact. */
export interface SpiChainLink {
  next: SpiByteHandler | null;
}
type Chained = SpiByteHandler & { [OWNER]?: string; [LINK]?: SpiChainLink };

/**
 * The link a new listener owned by `owner` should forward through: the channel
 * as it stands, with every earlier incarnation of `owner` removed — wherever it
 * sits, not just at the head. A stale listener one link down would otherwise
 * keep hearing the bus and decode every byte a second time.
 *
 * A handler that was assigned without this helper is opaque: the walk stops at
 * it, since there is no link to re-point.
 */
export function spiChainUnder(
  current: SpiByteHandler | null | undefined,
  owner: string,
): SpiChainLink {
  const mine = (h: Chained | null): boolean => !!h && h[OWNER] === owner;
  const under = (h: Chained | null): Chained | null => (h?.[LINK]?.next ?? null) as Chained | null;

  let head = (current ?? null) as Chained | null;
  while (mine(head)) head = under(head);

  for (let node = head; node && node[LINK]; node = node[LINK].next as Chained | null) {
    let nxt = node[LINK].next as Chained | null;
    while (mine(nxt)) nxt = under(nxt);
    node[LINK].next = nxt;
  }
  return { next: head };
}

/**
 * Take `handler` out of the channel, wherever it sits.
 *
 * A part that is unmounted while another listener sits on top of it cannot
 * simply hand the channel back — it does not hold it. Left in place it would
 * keep answering the bus from a torn-down state: a card whose store has been
 * cleared, still selected because its CS subscription is gone, reading every
 * block back as zeros with no card on the canvas to explain it.
 */
export function spiChainDetach(
  spi: { onByte: SpiByteHandler | null },
  handler: SpiByteHandler,
): void {
  const under = (h: Chained | null): Chained | null => (h?.[LINK]?.next ?? null) as Chained | null;
  let head = (spi.onByte ?? null) as Chained | null;
  while (head === handler) head = under(head);
  spi.onByte = head;
  for (let node = head; node && node[LINK]; node = node[LINK].next as Chained | null) {
    let nxt = node[LINK].next as Chained | null;
    while (nxt === handler) nxt = under(nxt);
    node[LINK].next = nxt;
  }
}

/** Tag `handler` as owned by `owner`, forwarding through `link`. */
export function spiChainTag(
  handler: SpiByteHandler,
  owner: string,
  link: SpiChainLink,
): SpiByteHandler {
  (handler as Chained)[OWNER] = owner;
  (handler as Chained)[LINK] = link;
  return handler;
}
