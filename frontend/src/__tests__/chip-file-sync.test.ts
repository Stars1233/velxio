// @vitest-environment jsdom
/**
 * chipFiles — chip.c / chip.json live as ordinary editor files in the chip's
 * group, two-way synced with component.properties (the storage contract).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, chipFileGroupId } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import {
  seedChipFileGroups,
  syncChipFilesOnce,
  chipSourceHash,
  CHIP_SOURCE_FILE,
  CHIP_MANIFEST_FILE,
  __resetChipFileSyncForTests,
} from '../services/chipFiles';

const CHIP_ID = 'chip-test-1';
const SRC = '#include "velxio-chip.h"\nvoid chip_setup(void) {}\n';
const MANIFEST = '{"name":"Test Chip","pins":["IN","OUT"]}';

function seedStores(props: Record<string, unknown> = {}) {
  useSimulatorStore.setState({
    components: [
      {
        id: CHIP_ID,
        metadataId: 'custom-chip',
        x: 0,
        y: 0,
        properties: { chipName: 'Test Chip', sourceC: SRC, chipJson: MANIFEST, wasmBase64: 'AAA=', ...props },
      } as never,
    ],
  } as never);
}

function group() {
  return useEditorStore.getState().fileGroups[chipFileGroupId(CHIP_ID)] ?? [];
}
function chipProps() {
  return useSimulatorStore.getState().components[0].properties as Record<string, unknown>;
}

beforeEach(() => {
  __resetChipFileSyncForTests();
  useEditorStore.getState().deleteFileGroup(chipFileGroupId(CHIP_ID));
  seedStores();
});

describe('seedChipFileGroups', () => {
  it('creates chip.c + chip.json from properties for every custom chip', () => {
    seedChipFileGroups();
    const files = group();
    expect(files.map((f) => f.name)).toEqual([CHIP_SOURCE_FILE, CHIP_MANIFEST_FILE]);
    expect(files[0].content).toBe(SRC);
    expect(files[1].content).toBe(MANIFEST);
  });

  it('adds missing chip files to a group loadExample already seeded', () => {
    const gid = chipFileGroupId(CHIP_ID);
    useEditorStore.getState().createFileGroup(gid, [{ name: 'scanner.s', content: 'org 0' }]);
    seedChipFileGroups();
    expect(group().map((f) => f.name).sort()).toEqual(['chip.c', 'chip.json', 'scanner.s']);
  });

  it('seeds a program file for programmable chips', () => {
    seedStores({ chipJson: '{"name":"Z80","pins":["CLK"],"programTargets":["z80"]}' });
    seedChipFileGroups();
    expect(group().map((f) => f.name)).toContain('program.c');
    expect(String(chipProps().programFile)).toBe('program.c');
  });
});

describe('syncChipFilesOnce', () => {
  it('user edit of chip.c flows to properties and invalidates the wasm', () => {
    seedChipFileGroups();
    const gid = chipFileGroupId(CHIP_ID);
    const src = group().find((f) => f.name === CHIP_SOURCE_FILE)!;
    const edited = SRC + '// edited\n';
    useEditorStore.getState().updateGroupFile(gid, src.id, edited);
    syncChipFilesOnce();
    expect(chipProps().sourceC).toBe(edited);
    expect(chipProps().wasmBase64).toBe('');
  });

  it('external properties change (agent) flows to the file', () => {
    seedChipFileGroups();
    const newSrc = '// agent wrote this\n' + SRC;
    const sim = useSimulatorStore.getState();
    sim.updateComponent(CHIP_ID, {
      properties: { ...chipProps(), sourceC: newSrc, wasmBase64: 'BBB=' },
    } as never);
    syncChipFilesOnce();
    const src = group().find((f) => f.name === CHIP_SOURCE_FILE)!;
    expect(src.content).toBe(newSrc);
    // Agent-programmed chips keep their fresh wasm — no invalidation.
    expect(chipProps().wasmBase64).toBe('BBB=');
  });

  it('does not propagate a mid-edit invalid chip.json', () => {
    seedChipFileGroups();
    const gid = chipFileGroupId(CHIP_ID);
    const json = group().find((f) => f.name === CHIP_MANIFEST_FILE)!;
    useEditorStore.getState().updateGroupFile(gid, json.id, '{"name":"Test Chip","pins":["IN",');
    syncChipFilesOnce();
    expect(chipProps().chipJson).toBe(MANIFEST);
    const valid = '{"name":"Test Chip","pins":["IN","OUT","VCC"]}';
    useEditorStore.getState().updateGroupFile(gid, json.id, valid);
    syncChipFilesOnce();
    expect(chipProps().chipJson).toBe(valid);
  });

  it('both changed -> properties win (the agent just compiled that source)', () => {
    seedChipFileGroups();
    const gid = chipFileGroupId(CHIP_ID);
    const src = group().find((f) => f.name === CHIP_SOURCE_FILE)!;
    useEditorStore.getState().updateGroupFile(gid, src.id, '// user was typing\n');
    const agentSrc = '// agent version\n';
    useSimulatorStore.getState().updateComponent(CHIP_ID, {
      properties: { ...chipProps(), sourceC: agentSrc },
    } as never);
    syncChipFilesOnce();
    expect(chipProps().sourceC).toBe(agentSrc);
    expect(group().find((f) => f.name === CHIP_SOURCE_FILE)!.content).toBe(agentSrc);
  });
});

describe('chipSourceHash', () => {
  it('is stable and change-sensitive', () => {
    expect(chipSourceHash(SRC)).toBe(chipSourceHash(SRC));
    expect(chipSourceHash(SRC)).not.toBe(chipSourceHash(SRC + ' '));
  });
});
