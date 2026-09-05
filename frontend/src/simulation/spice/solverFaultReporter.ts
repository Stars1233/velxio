/**
 * solverFaultReporter — a dead SPICE solve becomes something the user can read.
 *
 * When ngspice rejects the deck (the classic case: two ideal voltage sources on
 * one node -> "singular matrix"), the worker publishes an EMPTY nodeVoltages
 * map. Every meter then read 0 V, every LED went dark, and nothing said why:
 * `useElectricalStore.error` was only ever read by the two meters and the
 * hover overlay. Reported on velxio.dev 2026-09-05 as "my 9 V battery reads
 * 0 V" — the battery was fine, a 7805 output wired into the board's 5V pin
 * had killed the whole solve.
 *
 * This subscriber watches the store's `error` and, for each NEW hard error,
 * dispatches the same `velxio-circuit-fault` event the burnout monitor uses,
 * so the message lands in the output console under "Circuit check". One event
 * per distinct message: the continuous solver re-runs on every canvas change
 * and a still-broken circuit must not spam the log. Convergence chatter on a
 * transient analysis is not reported here — only a solve that produced no
 * voltages at all, or a message ngspice only prints for a rejected deck.
 */
import { useElectricalStore } from '../../store/useElectricalStore';
import { railVolts } from './boardPinGroups';

/** ngspice messages that mean "no operating point at all", not a warning. */
const HARD_ERROR_RE = /singular matrix|no such vector|circuit not parsed|error on line|fatal/i;

/** Name a V-source the way the user sees it on the canvas. */
export function describeSourceName(src: string): string {
  const s = src.toLowerCase();
  if (s === 'v_vcc_rail') return "the board's main supply rail (5V / VCC / 3V3 pins)";
  const aux = /^v_aux_rail_(.+)$/.exec(s);
  if (aux) return `the board's ${railVolts(aux[1]!)} supply pin`;
  return `source ${s}`;
}

/** Turn a raw ngspice line into a sentence with a likely fix. */
export function describeSolverError(raw: string): string {
  const text = raw.trim();
  const singular = /singular matrix:?\s*check node\s+(\S+?)#branch/i.exec(text);
  if (singular) {
    return (
      `The circuit has no solution: two voltage sources drive the same net ` +
      `(${describeSourceName(singular[1]!)}). Typical cause: a regulator or battery ` +
      `output wired straight into a board supply pin (5V / 3V3), or two supplies tied ` +
      `together. Remove one of them. Every meter and LED stays dead until then. (ngspice: ${text})`
    );
  }
  if (/singular matrix/i.test(text)) {
    return (
      `The circuit has no solution (ngspice: ${text}). Check for voltage sources wired ` +
      `against each other, or a source shorted by a wire.`
    );
  }
  return `Circuit solver problem: ${text}`;
}

function emitFault(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[circuit-sim] ${message}`);
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(
      new CustomEvent('velxio-circuit-fault', { detail: { kind: 'solver', message } }),
    );
  } catch {
    /* CustomEvent unavailable — the console.warn is enough */
  }
}

/** True when this snapshot is a rejected deck rather than a noisy success. */
export function isDeadSolve(state: {
  error: string | null;
  nodeVoltages: Record<string, number>;
  pinNetMap: Map<string, string>;
}): boolean {
  if (!state.error) return false;
  if (HARD_ERROR_RE.test(state.error)) return true;
  // A circuit with wired pins but not one solved voltage: nothing to read.
  return state.pinNetMap.size > 0 && Object.keys(state.nodeVoltages).length === 0;
}

/**
 * Subscribe to the electrical store; returns the unsubscribe handle.
 * Exported separately from the mount so tests can drive it without a DOM.
 */
export function startSolverFaultReporter(
  report: (message: string) => void = emitFault,
): () => void {
  let lastReported: string | null = null;
  return useElectricalStore.subscribe((state, prev) => {
    if (state.error === prev.error) return;
    if (!isDeadSolve(state)) {
      // A clean solve re-arms the reporter: the next failure is news again.
      if (!state.error) lastReported = null;
      return;
    }
    if (state.error === lastReported) return;
    lastReported = state.error;
    report(describeSolverError(state.error!));
  });
}
