/**
 * The three honest answers, and that a refusal is recorded and loud.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLineGaps, lineGaps, requestLine } from '../requestLine';
import { LineSensorHub } from '../LineSensorHub';
import type { LineCapable, LineHostPort } from '../LineHost';
import { NO_TIMED_EDGES_WHY } from '../LineHost';
import '../index';

function fakePort(): LineHostPort {
  return {
    now: () => 0,
    clockHz: () => 16e6,
    scheduleEdge: () => {},
    onPad: () => () => {},
    restPad: () => {},
  };
}

describe('requestLine', () => {
  beforeEach(() => {
    clearLineGaps();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('local: attaches to the board\'s own hub and hands back update/release', () => {
    const hub = new LineSensorHub(fakePort());
    const sim: LineCapable = { lineSupport: () => ({ mode: 'local' }), lineHub: () => hub };
    const a = requestLine(sim, { sensor_type: 'dht22', pin: 4, temperature: 20 });
    expect(a.mode).toBe('local');
    expect(hub.size).toBe(1);
    expect(hub.ownsPin(4)).toBe(true);
    if (a.mode === 'none') throw new Error('unreachable');
    a.update({ temperature: 30 });
    a.release();
    expect(hub.size).toBe(0);
    expect(lineGaps()).toEqual([]);
  });

  it('local: refuses a sensor with no registered model, and records it', () => {
    const sim: LineCapable = { lineSupport: () => ({ mode: 'local' }), lineHub: () => new LineSensorHub(fakePort()) };
    const a = requestLine(sim, { sensor_type: 'ds18b20', pin: 4 });
    expect(a.mode).toBe('none');
    expect(lineGaps()).toEqual([{ sensorType: 'ds18b20', pin: 4, why: expect.stringContaining('no line model') }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ds18b20'));
  });

  it('hosted: goes through the legacy sensor channel when the host lists the type', () => {
    const registerSensor = vi.fn().mockReturnValue(true);
    const updateSensor = vi.fn();
    const unregisterSensor = vi.fn();
    const sim = {
      lineSupport: () => ({ mode: 'hosted' as const, models: ['dht22', 'hc-sr04'] }),
      registerSensor,
      updateSensor,
      unregisterSensor,
    };
    const a = requestLine(sim, { sensor_type: 'hc-sr04', pin: 5, echo_pin: 6, distance: 12 });
    expect(a.mode).toBe('hosted');
    expect(registerSensor).toHaveBeenCalledWith('hc-sr04', 5, { echo_pin: 6, distance: 12 });
    if (a.mode === 'none') throw new Error('unreachable');
    a.update({ distance: 40 });
    expect(updateSensor).toHaveBeenCalledWith(5, { echo_pin: 6, distance: 40 }); // extra pins kept
    a.release();
    expect(unregisterSensor).toHaveBeenCalledWith(5);
  });

  it('hosted: refuses a type the host does not list, naming what it does model', () => {
    const sim = { lineSupport: () => ({ mode: 'hosted' as const, models: ['dht22'] }), registerSensor: vi.fn() };
    const a = requestLine(sim, { sensor_type: 'hc-sr04', pin: 5, echo_pin: 6 });
    expect(a.mode).toBe('none');
    if (a.mode !== 'none') throw new Error('unreachable');
    expect(a.why).toContain('dht22');
    expect(sim.registerSensor).not.toHaveBeenCalled();
  });

  it('hosted: a host that declines is a refusal, not a silent success', () => {
    const sim = { lineSupport: () => ({ mode: 'hosted' as const, models: ['dht22'] }), registerSensor: () => false };
    expect(requestLine(sim, { sensor_type: 'dht22', pin: 4 }).mode).toBe('none');
  });

  it('none: a board with no declaration refuses with the timed-edges reason', () => {
    const a = requestLine({ setPinState() {}, isRunning: () => false }, { sensor_type: 'dht22', pin: 4 });
    expect(a).toEqual({ mode: 'none', why: NO_TIMED_EDGES_WHY });
    expect(lineGaps()).toHaveLength(1);
  });

  it('none: a board that declares why passes its reason through', () => {
    const sim: LineCapable = { lineSupport: () => ({ mode: 'none', why: 'the guest polls its pins over a serial link' }) };
    const a = requestLine(sim, { sensor_type: 'dht22', pin: 4 });
    expect(a.mode === 'none' && a.why).toBe('the guest polls its pins over a serial link');
  });

  it('records the asking component so the circuit check can point at it', () => {
    requestLine(null, { sensor_type: 'dht22', pin: 4 }, { componentId: 'dht22-7' });
    expect(lineGaps()[0].componentId).toBe('dht22-7');
  });

  it('no board at all is a refusal too', () => {
    expect(requestLine(null, { sensor_type: 'dht22', pin: 4 }).mode).toBe('none');
  });

  it('a later success clears the recorded gap for that sensor and pin', () => {
    requestLine(null, { sensor_type: 'dht22', pin: 4 });
    expect(lineGaps()).toHaveLength(1);
    const sim: LineCapable = { lineSupport: () => ({ mode: 'local' }), lineHub: () => new LineSensorHub(fakePort()) };
    requestLine(sim, { sensor_type: 'dht22', pin: 4 });
    expect(lineGaps()).toHaveLength(0);
  });
});
