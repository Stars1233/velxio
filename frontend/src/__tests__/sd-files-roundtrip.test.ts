// @vitest-environment jsdom
/**
 * Files the user puts on a board's built-in microSD belong to the project.
 *
 * They did not survive a save. `serialisableBoard` wrote a board's
 * boardOptions and its SPIFFS uploads into boards_json and left sdFiles out,
 * `buildLoadPayload` had nothing to read back, and loadProjectState — which
 * recreates every board and then re-applies a whitelist of fields — did not
 * list them either. So a project saved with a file on its card reopened with
 * an empty one, and the sketch that reads that file found nothing. The .vlx
 * path serialised them all along and lost them on the same restore.
 *
 * Uploads are the user's input, like the SPIFFS files beside them, not derived
 * data like compiledProgram (which is deliberately not persisted).
 */
import { describe, it, expect } from 'vitest';
import { buildSavePayload } from '../utils/projectPayload';
import { buildLoadPayload } from '../pages/ProjectByIdPage';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { BoardInstance } from '../types/board';

const board = (over: Partial<BoardInstance> = {}): BoardInstance =>
  ({
    id: 'xiao-esp32s3-sense',
    boardKind: 'xiao-esp32-s3',
    x: 50,
    y: 50,
    running: false,
    compiledProgram: null,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
    activeFileGroupId: 'group-xiao-esp32s3-sense',
    languageMode: 'arduino',
    ...over,
  }) as BoardInstance;

const CARD = [{ name: 'hello.txt', contentB64: 'aGVsbG8K' }];

describe('a board card survives the trip through the project', () => {
  /** The save reads the live stores, like the Save button does. */
  const withBoards = (boards: BoardInstance[]) =>
    useSimulatorStore.setState({ boards, activeBoardId: boards[0].id } as never);

  it('is written into boards_json and read back out of it', () => {
    withBoards([board({ sdFiles: CARD })]);

    const payload = buildSavePayload();
    const saved = JSON.parse(payload.boards_json as string);
    expect(saved[0].sdFiles).toEqual(CARD);

    const loaded = buildLoadPayload({
      boards_json: payload.boards_json,
      components_json: '[]',
      wires_json: '[]',
      board_type: 'xiao-esp32-s3',
    } as never);
    expect(loaded.boards[0].sdFiles).toEqual(CARD);
  });

  it('keeps a board with an empty slot free of the field', () => {
    withBoards([board()]);
    const saved = JSON.parse(buildSavePayload().boards_json as string);
    expect(saved[0].sdFiles).toBeUndefined();
  });
});
