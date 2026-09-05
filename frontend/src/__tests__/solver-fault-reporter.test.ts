/**
 * The solver's error used to live only in useElectricalStore.error, read by
 * the two meters and the hover overlay. A rejected deck (singular matrix)
 * therefore looked like "everything reads 0 V". The reporter turns each new
 * hard error into one circuit-fault event, and stays quiet on repeats and on
 * convergence chatter that still produced voltages.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useElectricalStore } from '../store/useElectricalStore';
import {
  describeSolverError,
  isDeadSolve,
  startSolverFaultReporter,
} from '../simulation/spice/solverFaultReporter';

function publish(partial: { error: string | null; nodeVoltages?: Record<string, number>; pins?: number }) {
  const pinNetMap = new Map<string, string>();
  for (let i = 0; i < (partial.pins ?? 2); i++) pinNetMap.set(`c${i}:p`, `n${i}`);
  useElectricalStore.getState().setSolveResult({
    nodeVoltages: partial.nodeVoltages ?? {},
    branchCurrents: {},
    pinNetMap,
    analysisMode: 'op',
    timeWaveforms: undefined,
    converged: partial.error === null,
    error: partial.error,
    lastSolveMs: 0,
    submittedNetlist: '',
    sourcedNets: new Set(),
  });
}

describe('solverFaultReporter', () => {
  beforeEach(() => useElectricalStore.getState().reset());

  it('names the rail in the singular-matrix message', () => {
    const msg = describeSolverError('Warning: singular matrix:  check node v_vcc_rail#branch');
    expect(msg).toContain('two voltage sources drive the same net');
    expect(msg).toContain('main supply rail');
    expect(msg).toContain('regulator or battery output');
  });

  it('a rejected deck is dead; a noisy transient with voltages is not', () => {
    expect(isDeadSolve({ error: 'singular matrix', nodeVoltages: {}, pinNetMap: new Map() })).toBe(true);
    const pins = new Map([['a:1', 'n0']]);
    expect(isDeadSolve({ error: 'Warning: timestep too small', nodeVoltages: { n0: 1 }, pinNetMap: pins })).toBe(false);
    expect(isDeadSolve({ error: 'Warning: something', nodeVoltages: {}, pinNetMap: pins })).toBe(true);
    expect(isDeadSolve({ error: null, nodeVoltages: {}, pinNetMap: pins })).toBe(false);
  });

  it('reports one event per new error, re-arms after a clean solve', () => {
    const reported: string[] = [];
    const stop = startSolverFaultReporter((m) => reported.push(m));
    publish({ error: 'Warning: singular matrix:  check node v_vcc_rail#branch' });
    publish({ error: 'Warning: singular matrix:  check node v_vcc_rail#branch' });
    expect(reported).toHaveLength(1);
    publish({ error: null, nodeVoltages: { n0: 5 } });
    publish({ error: 'Warning: singular matrix:  check node v_vcc_rail#branch' });
    expect(reported).toHaveLength(2);
    publish({ error: 'Warning: timestep too small', nodeVoltages: { n0: 1 } });
    expect(reported).toHaveLength(2);
    stop();
    publish({ error: 'Warning: singular matrix:  check node v_bat#branch' });
    expect(reported).toHaveLength(2);
  });
});

describe('pickSolverError', () => {
  it('prefers the verdict over the fallback notes ngspice prints first', async () => {
    const { pickSolverError } = await import('../simulation/spice/solverFaultReporter');
    expect(
      pickSolverError([
        'Note: Starting dynamic gmin stepping',
        'Warning: dynamic gmin stepping failed',
        'Note: Starting source stepping',
        'Warning: singular matrix:  check node n0',
      ]),
    ).toBe('Warning: singular matrix:  check node n0');
    expect(pickSolverError(['Note: Starting dynamic gmin stepping', 'Warning: source stepping failed'])).toBe(
      'Warning: source stepping failed',
    );
    expect(pickSolverError(['Note: only a note'])).toBe('Note: only a note');
    expect(pickSolverError([])).toBeNull();
  });

  it('translates a shorted source to the component and the fix', async () => {
    const { describeSolverError, isDeadSolve } = await import('../simulation/spice/solverFaultReporter');
    const msg = describeSolverError('Fatal error: instance b_ic_74hc02_1788636438540_69gm8vczj_1 is a shorted ASRC');
    expect(msg).toContain('source ic_74hc02_1788636438540_69gm8vczj');
    expect(msg).toContain('both terminals on the same net');
    expect(isDeadSolve({ error: 'Fatal error: instance v_x is a shorted VSRC', nodeVoltages: {}, pinNetMap: new Map() })).toBe(true);
  });
});
