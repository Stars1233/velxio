/**
 * A note the simulator writes about a run ("[Velxio] e-paper: the panel
 * refreshed blank because...") has to be readable where the user is looking.
 *
 * On a Linux board that is the terminal, and the terminal is not fed by the
 * store: PiTerminal wraps the bridge's onSerialData and writes what arrives
 * there. A note appended to serialOutput alone was recorded and never seen:
 * a Pi 5 project with an e-paper got the diagnosis in its telemetry and a
 * blank panel with no explanation on screen.
 */
import { describe, it, expect } from 'vitest';

describe('appendSimulatorNote', () => {
  it('reaches a mounted Linux terminal, and the store through it', async () => {
    const { useSimulatorStore, getBoardBridge, appendSimulatorNote } = await import(
      '../store/useSimulatorStore'
    );
    const id = useSimulatorStore.getState().addBoard('raspberry-pi-5', 10, 10);
    const bridge = getBoardBridge(id)!;

    // What PiTerminal does on mount: write to xterm, then chain to the store.
    const terminal: string[] = [];
    const toStore = bridge.onSerialData;
    bridge.onSerialData = (ch: string) => {
      terminal.push(ch);
      toStore?.(ch);
    };

    appendSimulatorNote(id, 'e-paper: the image went to 0x10 only');

    expect(terminal.join('')).toContain('[Velxio] e-paper: the image went to 0x10 only');
    await new Promise((r) => setTimeout(r, 50)); // the serial batcher flushes per frame
    const board = useSimulatorStore.getState().boards.find((b) => b.id === id);
    expect(board?.serialOutput).toContain('[Velxio] e-paper: the image went to 0x10 only');
    expect(board?.serialOutput.match(/\[Velxio\] e-paper/g)?.length, 'written once, not twice').toBe(1);
  });

  it('still lands in the serial monitor of a board with no such bridge', async () => {
    const { useSimulatorStore, appendSimulatorNote } = await import('../store/useSimulatorStore');
    const id = useSimulatorStore.getState().addBoard('arduino-uno', 10, 10);

    appendSimulatorNote(id, 'a note for an MCU board');

    await new Promise((r) => setTimeout(r, 50));
    const board = useSimulatorStore.getState().boards.find((b) => b.id === id);
    expect(board?.serialOutput).toContain('[Velxio] a note for an MCU board');
  });
});
