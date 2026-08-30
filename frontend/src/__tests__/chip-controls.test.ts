// @vitest-environment jsdom
/**
 * chipControls — live SensorControlDef synthesized from a chip.json's
 * `controls` section (Wokwi-compatible) or its ranged `attributes`.
 */
import { describe, it, expect } from 'vitest';
import {
  synthesizeChipControls,
  getSensorControlForComponent,
} from '../simulation/customChips/chipControls';

describe('synthesizeChipControls', () => {
  it('builds sliders from the Wokwi controls section', () => {
    const def = synthesizeChipControls(JSON.stringify({
      name: 'CO2 Sensor',
      pins: ['OUT'],
      attributes: [{ name: 'ppm', default: 1000, min: 400, max: 5000 }],
      controls: [{ id: 'ppm', label: 'CO2 (ppm)', type: 'range', min: 400, max: 5000, step: 10, unit: 'ppm' }],
    }));
    expect(def).toBeDefined();
    expect(def!.title).toBe('CO2 Sensor');
    expect(def!.controls).toEqual([
      expect.objectContaining({ type: 'slider', key: 'ppm', min: 400, max: 5000, step: 10, unit: 'ppm', defaultValue: 1000 }),
    ]);
    expect(def!.defaultValues).toEqual({ ppm: 1000 });
  });

  it('falls back to sliders for ranged attributes with no controls section', () => {
    const def = synthesizeChipControls(JSON.stringify({
      name: 'Pulse Counter',
      pins: ['IN'],
      attributes: [
        { name: 'threshold', type: 'int', default: 4, min: 1, max: 1024 },
        { name: 'mode', default: 1 },
      ],
    }));
    expect(def!.controls).toHaveLength(1);
    expect(def!.controls[0]).toMatchObject({ type: 'slider', key: 'threshold', min: 1, max: 1024, step: 1 });
  });

  it('supports button controls', () => {
    const def = synthesizeChipControls(JSON.stringify({
      name: 'Trigger',
      pins: ['OUT'],
      controls: [{ id: 'fire', label: 'Fire', type: 'button' }],
    }));
    expect(def!.controls).toEqual([{ type: 'button', key: 'fire', label: 'Fire' }]);
  });

  it('returns undefined for chips with nothing tunable, bad json, or empty', () => {
    expect(synthesizeChipControls('{"name":"Inverter","pins":["IN","OUT"]}')).toBeUndefined();
    expect(synthesizeChipControls('not json')).toBeUndefined();
    expect(synthesizeChipControls('')).toBeUndefined();
  });
});

describe('getSensorControlForComponent', () => {
  it('resolves catalog sensors by metadataId first', () => {
    const def = getSensorControlForComponent({ id: 'x', metadataId: 'dht22', properties: {} });
    expect(def).toBeDefined();
  });

  it('synthesizes for custom chips from their own chipJson', () => {
    const def = getSensorControlForComponent({
      id: 'x',
      metadataId: 'custom-chip',
      properties: {
        chipJson: '{"name":"S","pins":["OUT"],"attributes":[{"name":"v","min":0,"max":10,"default":5}]}',
      },
    });
    expect(def!.controls[0]).toMatchObject({ key: 'v', min: 0, max: 10 });
  });

  it('gives non-sensor parts nothing', () => {
    expect(getSensorControlForComponent({ id: 'x', metadataId: 'resistor', properties: {} })).toBeUndefined();
  });
});
