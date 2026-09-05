/**
 * The 2026-09-05 canvas: a 9 V cell into a 7805 whose VOUT is wired into the
 * board's 5V pin. The board's 5V pin is the ideal V_VCC_RAIL source and the
 * 7805 is an ideal B-source, two sources on one node -> ngspice "singular
 * matrix" -> the live solver published no voltages and a voltmeter across a
 * second, perfectly wired battery read "0 V". The pre-flight said nothing.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { findSourceConflicts, verifyCircuit } from '../simulation/verify/circuitVerifier';
import type { BuildNetlistInput } from '../simulation/spice/types';

const wire = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

function incident(voutToRail: boolean): BuildNetlistInput {
  const wires = [
    wire('w1', ['bat', '+'], ['reg', 'VIN']),
    wire('w2', ['bat', '−'], ['reg', 'GND']),
    wire('w3', ['reg', 'GND'], ['uno', 'GND.1']),
  ];
  if (voutToRail) wires.push(wire('w4', ['reg', 'VOUT'], ['uno', '5V']));
  return {
    components: [
      { id: 'bat', metadataId: 'battery-9v', properties: {} },
      { id: 'reg', metadataId: 'reg-7805', properties: {} },
    ],
    wires,
    boards: [
      {
        id: 'uno',
        boardKind: 'arduino-uno',
        vcc: 5,
        groundPinNames: ['GND.1', 'GND.2'],
        vccPinNames: ['5V'],
        pins: {},
      } as BuildNetlistInput['boards'][number],
    ],
    analysis: { kind: 'op' },
  };
}

describe('source-conflict pre-flight rule', () => {
  it('names the regulator and the rail when VOUT is wired into the 5V pin', () => {
    const input = incident(true);
    const { netlist } = buildNetlist(input);
    const found = findSourceConflicts(netlist, input);
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe('source-conflict');
    expect(found[0]!.severity).toBe('error');
    expect(found[0]!.componentId).toBe('reg');
    expect(found[0]!.message).toContain('reg-7805 reg output (VOUT)');
    expect(found[0]!.message).toContain('main supply rail');
  });

  it('is silent for the same circuit without that wire', () => {
    const input = incident(false);
    const { netlist } = buildNetlist(input);
    expect(findSourceConflicts(netlist, input)).toEqual([]);
  });

  it('flags a source shorted onto its own reference', () => {
    const input = incident(false);
    const found = findSourceConflicts('B_reg 0 0 V = min(V(n0)-2, 5)\n.op\n.end', input);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('reg-7805 reg output (VOUT)');
  });

  it('verifyCircuit blocks the incident circuit and never reports it as clean', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(incident(true));
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('source-conflict');
    expect(result.warnings.map((w) => w.code)).not.toContain('solver-failed');
  });

  it('verifyCircuit passes the corrected circuit', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(incident(false));
    expect(result.errors.map((e) => e.code)).not.toContain('source-conflict');
    expect(result.errors.map((e) => e.code)).not.toContain('solver-failed');
  });
});
