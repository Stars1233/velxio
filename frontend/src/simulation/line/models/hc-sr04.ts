/**
 * HC-SR04 ultrasonic ranger — a trigger on one wire, a timed pulse back on
 * another.
 *
 *  1. MCU raises TRIG (>= 10 us)
 *  2. ~600 us later the sensor raises ECHO
 *  3. ECHO stays high for the round trip: distance_cm / 17150 s (~58 us/cm)
 *  4. ECHO falls
 *
 * Two edges, so the timeline does NOT treat the frame as self-timed: every
 * ultrasonic driver in the catalog (arduino-esp32 pulseIn, NewPing, the hcsr04
 * library) times the echo with micros(), which a fenced skip keeps exact, and
 * holding a never-idle sketch's catch-up for up to 24 ms per ping would cost
 * it almost all of it.
 */

import { assertedHigh } from '../padEvent';
import type { HostEdgeFrame } from '../LineTimeline';
import { numberField, registerLineModel, type LineClock, type LineModel } from '../lineModels';

export const HCSR04_DEFAULT_DISTANCE_CM = 10;
export const HCSR04_MIN_DISTANCE_CM = 2;
export const HCSR04_MAX_DISTANCE_CM = 400;
/** Sensor overhead between the trigger and the start of the echo. */
export const HCSR04_PROCESSING_US = 600;
/** Round-trip speed of sound: distance_cm / 17150 seconds of echo. */
export const HCSR04_CM_PER_SECOND = 17150;

export function clampDistanceCm(cm: number): number {
  return Math.max(HCSR04_MIN_DISTANCE_CM, Math.min(HCSR04_MAX_DISTANCE_CM, cm));
}

/** The ECHO pulse for a trigger at `triggerCycle`. */
export function hcsr04Frame(
  echoPin: number,
  triggerCycle: number,
  distanceCm: number,
  us: (n: number) => number,
): HostEdgeFrame {
  const processing = us(HCSR04_PROCESSING_US);
  const echo = us((distanceCm / HCSR04_CM_PER_SECOND) * 1e6);
  return {
    pin: echoPin,
    edges: [
      { level: true, atCycle: triggerCycle + processing },
      { level: false, atCycle: triggerCycle + processing + echo },
    ],
  };
}

registerLineModel('hc-sr04', (rec) => {
  const trigPin = rec.pin;
  const echoPin = numberField(rec.echo_pin, NaN);
  let distanceCm = clampDistanceCm(numberField(rec.distance, HCSR04_DEFAULT_DISTANCE_CM));
  let busyUntil = -Infinity;

  const model: LineModel = {
    listens: [trigPin],
    drives: Number.isFinite(echoPin) ? [echoPin] : [],
    rest: () => (Number.isFinite(echoPin) ? [{ pin: echoPin, level: false, driven: true }] : []),
    onPad(e, clock: LineClock) {
      if (!Number.isFinite(echoPin)) return null;
      if (!assertedHigh(e)) return null;
      const now = clock.now();
      if (now < busyUntil) return null; // still emitting the previous echo
      const frame = hcsr04Frame(echoPin, now, distanceCm, clock.us);
      busyUntil = frame.edges[frame.edges.length - 1].atCycle;
      return frame;
    },
    update(props) {
      if ('distance' in props) distanceCm = clampDistanceCm(numberField(props.distance, distanceCm));
    },
    reset() {
      busyUntil = -Infinity;
    },
  };
  return model;
});
