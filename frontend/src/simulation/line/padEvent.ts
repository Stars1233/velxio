/**
 * padEvent — what a board pad is DOING, reported the same way by every
 * simulator.
 *
 * Every simulator used to report the LEVEL it happened to write: avr8js the
 * PORT bit, rp2040js the latch, the ESP32 engines GPIO_OUT. That loses the one
 * event a single-wire sensor is waiting for. A DHT22, a DS18B20, an HC-SR04's
 * partner on a shared line — all of them end the master's start signal by
 * RELEASING the wire: `pinMode(INPUT_PULLUP)`, a change of DIRECTION that
 * writes no level. A level-only listener sees the falling edge of the start
 * signal and then nothing, the sensor never answers, and the sketch prints its
 * failure line forever. That is how the same DHT22 went dead on three board
 * families for three different-looking reasons.
 *
 * So the unit of reporting is the pad's drive state, not a level: driving low,
 * driving high, or released (`'z'`), plus the pull the guest programmed and
 * the guest cycle it happened at. The two questions every line-owning model
 * asks are derived once, below, so no part re-derives them and gets them
 * subtly wrong.
 */

/** What the MCU is doing to the pad. `'z'` = released: an input, high-Z. */
export type PadDrive = 'low' | 'high' | 'z';

/** Internal pull the guest programmed: 0 none, 1 up, 2 down. */
export type PadPull = 0 | 1 | 2;

export interface PadState {
  drive: PadDrive;
  pull: PadPull;
  /**
   * The line's resting level: the driven level while driving, else what the
   * pull would produce, else the previous level (a bus keeper, or nothing at
   * all on the pad — a released line with no pull keeps what it had).
   */
  level: boolean;
  /** Guest cycles at the change, in the board's own base. -1 = no counter. */
  cycle: number;
}

export interface PadEvent extends PadState {
  pin: number;
  prev: Readonly<PadState>;
}

/** The state a pad has before the guest ever touches it: released, no pull. */
export const INITIAL_PAD: Readonly<PadState> = Object.freeze({
  drive: 'z' as PadDrive,
  pull: 0 as PadPull,
  level: false,
  cycle: -1,
});

/**
 * The MCU let go of a line it was holding low. Both release idioms qualify:
 * push-pull drivers release by going to input (`drive` becomes `'z'`), and
 * open-drain drivers release by writing a one (`drive` becomes `'high'`). A
 * model that genuinely needs the high-Z form tests `e.drive === 'z'` on top.
 */
export const releasedLow = (e: PadEvent): boolean => e.prev.drive === 'low' && e.drive !== 'low';

/**
 * The MCU started holding a line low. Includes the case a level listener can
 * never see: the latch already reads zero and the pin goes input -> output. That
 * is a 1-Wire reset pulse on AVR, where DDR changes with PORT unchanged.
 */
export const assertedLow = (e: PadEvent): boolean => e.prev.drive !== 'low' && e.drive === 'low';

/** The MCU started driving the line high (a TRIG pulse starts this way). */
export const assertedHigh = (e: PadEvent): boolean =>
  e.prev.drive !== 'high' && e.drive === 'high';

/** The pad went high-Z from any driven state. */
export const wentHiZ = (e: PadEvent): boolean => e.prev.drive !== 'z' && e.drive === 'z';

/**
 * The resting level of a pad from its drive and pull. `previous` is what the
 * line held before, for a released pad with no pull — nothing on silicon moves
 * it, so the model keeps it.
 */
export function restingLevel(drive: PadDrive, pull: PadPull, previous: boolean): boolean {
  if (drive === 'high') return true;
  if (drive === 'low') return false;
  if (pull === 1) return true;
  if (pull === 2) return false;
  return previous;
}
