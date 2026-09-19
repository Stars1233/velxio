// @vitest-environment jsdom
/**
 * What the solved circuit is allowed to tell a digital input.
 *
 * connectDigitalInputsToMcu turns a node voltage into digitalRead()'s answer,
 * which makes it the one place where a numerical artifact becomes a fact the
 * firmware acts on. A user's relay project oscillated for ever because it did:
 * inputs held at 3.3 V by external pull-ups kept reading LOW together, several
 * at once, with nothing touching them (issue #333). A transient step that does
 * not converge — which relay coils, ideal switches and flyback diodes invite —
 * hands back NaN for every node, and NaN failed both threshold tests and fell
 * through to a default of LOW.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sim = { setPinState: vi.fn(), spiceDrivenInputs: true, ownsPin: () => false };
const pinManager = { getOutputPins: () => new Set<number>() };

vi.mock('../store/useSimulatorStore', async () => {
  const boards = [{ id: 'esp32', boardKind: 'esp32-devkit-v1', vcc: 3.3 }];
  return {
    useSimulatorStore: {
      getState: () => ({ boards }),
      subscribe: () => () => {},
    },
    getBoardSimulator: () => sim,
    getBoardPinManager: () => pinManager,
  };
});

const electrical = {
  nodeVoltages: {} as Record<string, number>,
  pinNetMap: new Map<string, string>([['esp32:25', 'n1']]),
  sourcedNets: new Set<string>(['n1']),
};
vi.mock('../store/useElectricalStore', () => ({
  useElectricalStore: {
    getState: () => electrical,
    subscribe: () => () => {},
  },
}));

const { connectDigitalInputsToMcu } = await import('../simulation/spice/connectDigitalInputsToMcu');

/** Publish one solve and return what reached the guest, if anything. */
function solve(v: number): Array<[number, boolean]> {
  sim.setPinState.mockClear();
  electrical.nodeVoltages = { n1: v };
  connectDigitalInputsToMcu()(); // mount runs one pass, then unsubscribe
  return sim.setPinState.mock.calls as Array<[number, boolean]>;
}

describe('a solved node becoming a digital input level', () => {
  beforeEach(() => sim.setPinState.mockClear());

  it('drives HIGH from a pulled-up node and LOW from a grounded one', () => {
    expect(solve(3.3)).toEqual([[25, true]]);
    expect(solve(0)).toEqual([[25, false]]);
  });

  it('never turns a non-converged solve into an edge', () => {
    expect(solve(NaN), 'NaN is not a level').toEqual([]);
    expect(solve(Infinity), 'nor is an infinity').toEqual([]);
    expect(solve(-Infinity)).toEqual([]);
  });

  it('says nothing about a node sitting in the undefined band', () => {
    // 1.4 V on a 3.3 V part is neither a one nor a zero, and with no history
    // there is nothing to hold — so the guest keeps whatever it had.
    expect(solve(1.4)).toEqual([]);
  });
});
