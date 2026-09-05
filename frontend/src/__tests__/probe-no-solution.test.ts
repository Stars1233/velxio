/**
 * Regression: a probe whose nets the solver did not report must not print
 * "0.00 µV" as if it had measured something.
 *
 * Reported on velxio.dev 2026-09-05: a 9 V cell wired straight to a
 * voltmeter "read 0 V". The pair was fine; elsewhere on the canvas a 7805's
 * VOUT was wired into the board's 5V pin, two ideal sources on one node,
 * ngspice answered "singular matrix", the worker published an EMPTY
 * nodeVoltages map, and `?? 0` turned that into a reading.
 */
import { describe, it, expect } from 'vitest';
import {
  readVoltmeter,
  readAmmeter,
  SOLVER_ERROR_DISPLAY,
  NO_READING_DISPLAY,
} from '../simulation/spice/probes';
import type { ElectricalSolveResult } from '../simulation/spice/types';

const vm = { id: 'vm', metadataId: 'instr-voltmeter', properties: {} };
const am = { id: 'am', metadataId: 'instr-ammeter', properties: {} };
const lookup = (_c: string, pin: string) => (pin === 'V+' ? 'n0' : pin === 'V-' ? 'n1' : null);

function solve(partial: Partial<ElectricalSolveResult>): ElectricalSolveResult {
  return {
    nodeVoltages: {},
    branchCurrents: {},
    converged: true,
    error: null,
    solveMs: 0,
    submittedNetlist: '',
    pinNetMap: new Map(),
    analysisMode: 'op',
    ...partial,
  };
}

describe('probes with no operating point', () => {
  it('voltmeter: empty nodeVoltages after a solver error is "solver error", not 0 V', () => {
    const r = readVoltmeter(vm, lookup, solve({
      converged: false,
      error: 'Warning: singular matrix:  check node v_vcc_rail#branch',
    }));
    expect(r.display).toBe(SOLVER_ERROR_DISPLAY);
    expect(r.unit).toBe('—');
    expect(r.stale).toBe(true);
  });

  it('voltmeter: a probe net missing from a clean snapshot is "no reading"', () => {
    const r = readVoltmeter(vm, lookup, solve({ nodeVoltages: { n0: 4.5 } }));
    expect(r.display).toBe(NO_READING_DISPLAY);
    expect(r.stale).toBe(true);
  });

  it('voltmeter: both nets reported still reads the difference', () => {
    const r = readVoltmeter(vm, lookup, solve({ nodeVoltages: { n0: 4.5, n1: -4.5 } }));
    expect(r.display).toBe('9.000 V');
    expect(r.stale).toBe(false);
  });

  it('voltmeter: ground is a reported 0 V, not a missing net', () => {
    const gnd = (_c: string, pin: string) => (pin === 'V+' ? 'n0' : '0');
    const r = readVoltmeter(vm, gnd, solve({ nodeVoltages: { n0: 3.3 } }));
    expect(r.display).toBe('3.300 V');
  });

  it('ammeter: missing sense branch after a solver error is "solver error"', () => {
    const r = readAmmeter(am, solve({ converged: false, error: 'singular matrix' }));
    expect(r.display).toBe(SOLVER_ERROR_DISPLAY);
    expect(r.stale).toBe(true);
  });

  it('ammeter: missing sense branch without an error keeps the wiring hint', () => {
    const r = readAmmeter(am, solve({}));
    expect(r.display).toBe('— no sense reading');
  });
});
