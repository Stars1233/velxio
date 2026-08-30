/**
 * chipControls — live simulation controls for custom chips.
 *
 * A chip.json may declare a Wokwi-compatible `controls` section (sliders /
 * buttons operated WHILE the simulation runs); each control drives the
 * attribute with the same id, which the chip re-reads via vx_attr_read.
 * As a velxio extension, any `attributes` entry with min+max also renders
 * as a slider when no explicit control claims it — so existing example
 * chips get live sliders with no manifest change.
 *
 * Catalog sensors key their SensorControlDef by metadataId; every custom
 * chip shares 'custom-chip', so this module synthesizes a def PER COMPONENT
 * from its chipJson. `getSensorControlForComponent` is the instance-aware
 * lookup used by the canvas and the panel.
 */
import {
  getSensorControl,
  type SensorControl,
  type SensorControlDef,
} from '../sensorControlConfig';
import { useSimulatorStore } from '../../store/useSimulatorStore';

interface ChipAttributeDef {
  name?: unknown;
  label?: unknown;
  type?: unknown;
  default?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
}

interface ChipControlDef {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
  unit?: unknown;
  scale?: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Synthesize the live-control panel definition from a chip.json string. */
export function synthesizeChipControls(chipJsonStr: string): SensorControlDef | undefined {
  const cached = cache.get(chipJsonStr);
  if (cached !== undefined) return cached === null ? undefined : cached;

  let def: SensorControlDef | null = null;
  try {
    const obj = JSON.parse(chipJsonStr || '{}') as {
      name?: unknown;
      attributes?: ChipAttributeDef[];
      controls?: ChipControlDef[];
    };
    const attributes = Array.isArray(obj.attributes) ? obj.attributes : [];
    const declared = Array.isArray(obj.controls) ? obj.controls : [];
    const attrByName = new Map(
      attributes.filter((a) => str(a.name)).map((a) => [String(a.name), a]),
    );

    const controls: SensorControl[] = [];
    const defaults: Record<string, number | boolean> = {};

    for (const c of declared) {
      const id = str(c.id);
      if (!id) continue;
      const attr = attrByName.get(id);
      const type = str(c.type);
      if (type === 'button') {
        controls.push({ type: 'button', key: id, label: str(c.label) ?? id });
        continue;
      }
      if (type !== 'range') continue;
      const min = num(c.min) ?? num(attr?.min) ?? 0;
      const max = num(c.max) ?? num(attr?.max) ?? 100;
      const dflt = num(attr?.default) ?? min;
      controls.push({
        type: 'slider',
        key: id,
        label: str(c.label) ?? str(attr?.label) ?? id,
        min,
        max,
        step: num(c.step) ?? num(attr?.step) ?? (max - min > 20 ? 1 : 0.01),
        unit: str(c.unit) ?? '',
        defaultValue: dflt,
        ...(c.scale === 'log' && min >= 0 ? { scale: 'log' as const } : {}),
      });
      defaults[id] = dflt;
    }

    // Fallback: slider per ranged attribute not already claimed by a control.
    const claimed = new Set(controls.map((c) => c.key));
    for (const a of attributes) {
      const name = str(a.name);
      if (!name || claimed.has(name)) continue;
      const min = num(a.min);
      const max = num(a.max);
      if (min === undefined || max === undefined) continue;
      const dflt = num(a.default) ?? min;
      controls.push({
        type: 'slider',
        key: name,
        label: str(a.label) ?? name,
        min,
        max,
        step: num(a.step) ?? (a.type === 'int' ? 1 : max - min > 20 ? 1 : 0.01),
        unit: '',
        defaultValue: dflt,
      });
      defaults[name] = dflt;
    }

    if (controls.length > 0) {
      def = {
        title: str(obj.name) ?? 'Custom Chip',
        controls,
        defaultValues: defaults,
      };
    }
  } catch {
    def = null;
  }

  cache.set(chipJsonStr, def);
  if (cache.size > 200) {
    // Cheap bound — drop the oldest half when the cap trips.
    let i = 0;
    for (const k of cache.keys()) {
      if (i++ >= 100) break;
      cache.delete(k);
    }
  }
  return def === null ? undefined : def;
}

const cache = new Map<string, SensorControlDef | null>();

/**
 * Instance-aware SensorControlDef lookup: catalog sensors by metadataId,
 * custom chips (and per-user saved chips, which reuse the same element) by
 * their own chip.json.
 */
export function getSensorControlForComponent(component: {
  id: string;
  metadataId?: string;
  properties?: Record<string, unknown>;
}): SensorControlDef | undefined {
  const byId = getSensorControl(component.metadataId);
  if (byId) return byId;
  if (component.metadataId === 'custom-chip') {
    return synthesizeChipControls(String(component.properties?.chipJson ?? ''));
  }
  return undefined;
}

/** Same lookup when only the component id is at hand (the sensor panel). */
export function getSensorControlForComponentId(componentId: string): SensorControlDef | undefined {
  const comp = useSimulatorStore
    .getState()
    .components.find((c: { id: string }) => c.id === componentId);
  return comp ? getSensorControlForComponent(comp) : undefined;
}
