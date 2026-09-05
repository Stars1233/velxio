/**
 * A GPIO V-source for a board the OSS pin-group table does not know (an
 * overlay board registered through proBoardRegistry, e.g. a pro XIAO) must be
 * stamped at THAT board's logic voltage. collectPinStates indexed
 * BOARD_PIN_GROUPS directly and fell back to the 5 V default, so a 3.3 V pro
 * board's HIGH pin read 5.000 V on a voltmeter and over-drove its LED after
 * every netlist rebuild, while the edge path altered the same source at 3.3 V
 * (velxio.dev, XIAO ESP32S3 Sense, 2026-09-05).
 */
import { describe, it, expect } from 'vitest';
import { registerProBoards } from '../lib/proBoardRegistry';
import { boardPinGroupFor } from '../simulation/spice/boardPinGroups';
import { collectPinStates, pinNameToArduinoPin } from '../simulation/spice/collectPinStates';
import { useSimulatorStore, getBoardPinManager } from '../store/useSimulatorStore';
import type { BoardKind } from '../types/board';

const KIND = 'test-pro-3v3-board';

registerProBoards([
  {
    kind: KIND,
    label: 'Test 3V3',
    fqbn: 'x:y:z',
    description: '',
    tag: 'velxio-test-board',
    size: { w: 10, h: 10 },
    render: () => null as never,
    pinToNumber: (p: string) => (p === 'D7' ? 44 : p === 'GND' || p === '3V3' || p === '5V' ? -1 : null),
    power: { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3'], aux: { volts: 5, pins: ['5V'] } },
  } as never,
]);

describe('collectPinStates on a pro board with its own rails', () => {
  it('resolves the registry power, not the 5 V default', () => {
    expect(boardPinGroupFor(KIND).vcc).toBe(3.3);
    expect(pinNameToArduinoPin('D7', KIND as BoardKind)).toBe(44);
    expect(pinNameToArduinoPin('3V3', KIND as BoardKind)).toBe(-1);
  });

  it('stamps a HIGH GPIO at 3.3 V', () => {
    const boardId = 'xiao-test';
    useSimulatorStore.getState().addBoard(KIND as BoardKind, 0, 0, boardId);
    const pm = getBoardPinManager(boardId)!;
    pm.triggerPinChange(44, true, 'mcu');
    const states = collectPinStates(boardId, KIND as BoardKind, [
      { start: { componentId: boardId, pinName: 'D7' }, end: { componentId: 'led', pinName: 'A' } },
    ]);
    expect(states['D7']).toEqual({ type: 'digital', v: 3.3 });
    useSimulatorStore.getState().removeBoard(boardId);
  });
});
