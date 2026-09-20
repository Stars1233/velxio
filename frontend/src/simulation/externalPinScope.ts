/**
 * The half of a digital scope channel that the CPU core cannot report: the
 * levels the CIRCUIT puts on a pin.
 *
 * Every simulator fires `onPinChangeWithTime` — the oscilloscope's digital
 * source — from its core's OUTPUT path. avr8js calls a port listener when the
 * sketch writes PORT/DDR; rp2040js calls a pin listener when the pad's driven
 * value changes. An externally applied level goes through a different door
 * (`AVRIOPort.setPin`, `GPIOPin.setInputValue`, an `esp32_gpio_in` message)
 * and NONE of those notify a listener: they move the input register and
 * nothing else.
 *
 * So a button on an INPUT_PULLUP pin moved the PIN register — `digitalRead`
 * saw the press, the sketch reacted, the LED toggled — while the scope went
 * on drawing the level the last PORT write implied, the pull-up's HIGH,
 * forever. That is the "my button pin reads LOW but the scope shows it stuck
 * HIGH" report, and it is the same on every family: on the Pico the channel
 * simply stays empty, because an input pin's listener value is a pull state,
 * not a level.
 *
 * Simulators emit through here from `setPinState`, which is the single door
 * every external level comes through: the SPICE connector
 * (connectDigitalInputsToMcu) for a button / divider / cross-board output, a
 * part that drives its own line (HC-SR04 ECHO, DHT22), the line hub's rest
 * pad, a custom chip's output.
 */

/** The scope sink a simulator exposes as `onPinChangeWithTime`. */
export type PinChangeSink = (pin: number, state: boolean, timeMs: number) => void;

export class ExternalPinScopeFeed {
  /** Last level reported from the external door, per pin. */
  private last = new Map<number, boolean>();

  /** Board clock, in milliseconds. */
  private readonly timeMs: () => number;

  /**
   * @param timeMs board clock in milliseconds, read in the SAME base the
   *   simulator's own edges use — CPU cycles for a core that runs in the tab,
   *   `performance.now()` for a bridge whose guest runs elsewhere. Mixing the
   *   two on one channel puts the external edge at a timestamp that has
   *   nothing to do with the driven ones around it.
   */
  constructor(timeMs: () => number) {
    this.timeMs = timeMs;
  }

  /**
   * Report an external level, unless it repeats what this door last reported.
   *
   * The repeat guard matters because the solver re-asserts every input pin on
   * every solve (~20 Hz): without it a held button buries its own falling edge
   * under a thousand identical samples, and a `single` trigger re-arms onto
   * noise instead of the next real press.
   */
  emit(sink: PinChangeSink | null, pin: number, state: boolean): void {
    if (this.last.get(pin) === state) return;
    this.last.set(pin, state);
    sink?.(pin, state, this.timeMs());
  }

  /**
   * Forget what this door last reported for `pin`.
   *
   * Called from the simulator's OWN edge path: once the core has driven the
   * pad, the memory here describes a level that is no longer on the wire, and
   * the next external level must be reported even when it happens to match.
   */
  forget(pin: number): void {
    this.last.delete(pin);
  }

  /** Board reset / new firmware: nothing on the pads is remembered. */
  reset(): void {
    this.last.clear();
  }
}
