/**
 * LineHost — the four things a line-owning sensor needs from whatever is
 * emulating the MCU, as one interface a simulator implements, plus the
 * declaration a board makes about which of them it can honour.
 *
 *   1. tell me when the guest drives or releases my line   -> onPad
 *   2. let me place edges at exact guest instants          -> scheduleEdge
 *   3. tell me what guest instant it is now                -> now / clockHz
 *   4. let nobody else drive my pad                        -> the hub claims it
 *
 * Every simulator used to implement a random subset of these, silently: a part
 * on a board with no `schedulePinChange` degraded into a zero-width reply and
 * the user saw a dead sensor with no message. With the declaration, a part
 * asks for what it needs and gets one of three honest answers — the model runs
 * here, the model runs somewhere else (a backend worker, an engine's own hub),
 * or this board cannot host it and here is why. `none` is a legitimate answer;
 * silence is not.
 */

import type { PadEvent } from './padEvent';
import type { EdgeSink } from './LineTimeline';
import type { LineSensorHub } from './LineSensorHub';

/** The port a simulator provides for line-owning models. */
export interface LineHostPort extends EdgeSink {
  /** Current guest cycle. */
  now(): number;
  /** Cycles per second of the guest's CONFIGURED clock (see LineClock.us). */
  clockHz(): number;
  /** Guest drive-state changes on one pad, direction included. */
  onPad(pin: number, cb: (e: PadEvent) => void): () => void;
  /**
   * Put a pad at rest. `driven` false: release it, the pull decides the level
   * (an engine that models host ownership must not own the pad here). `driven`
   * true: hold the level from the host side.
   */
  restPad(pin: number, level: boolean, driven: boolean): void;
}

/** What a board says about hosting line-owning sensors. */
export type LineSupport =
  /** This simulator implements {@link LineHostPort}; the models run here. */
  | { mode: 'local' }
  /** The models run elsewhere (a backend worker, an engine's own hub); these `sensor_type`s are served. */
  | { mode: 'hosted'; models: readonly string[] }
  /** Cannot host one. `why` is shown to the user. */
  | { mode: 'none'; why: string };

/**
 * A simulator that can answer the declaration. A `local` one owns a
 * {@link LineSensorHub} built over its own port: it needs the hub itself, to
 * ask `skipBudget` from inside its time-skipping loop, so the hub is not
 * something a caller creates for it.
 */
export interface LineCapable {
  lineSupport(): LineSupport;
  /** Present when `lineSupport().mode === 'local'`. */
  lineHub?(): LineSensorHub;
}

/** True when a simulator object exposes the declaration. */
export function isLineCapable(sim: unknown): sim is LineCapable {
  return !!sim && typeof (sim as LineCapable).lineSupport === 'function';
}

/** The declaration of an arbitrary simulator object, `none` when it makes none. */
export function lineSupportOf(sim: unknown): LineSupport {
  if (isLineCapable(sim)) return sim.lineSupport();
  return { mode: 'none', why: NO_TIMED_EDGES_WHY };
}

/** The reason a simulator with no declaration refuses: it cannot place edges in guest time. */
export const NO_TIMED_EDGES_WHY = "this board's emulator does not place timed edges on a pad";
