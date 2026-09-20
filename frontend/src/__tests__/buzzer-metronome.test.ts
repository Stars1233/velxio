/**
 * Buzzer — metronome quality
 *
 * A real use case for the buzzer: an Arduino sketch driving it as a metronome
 * (analogWrite/Timer PWM, an accent on the down-beat). This exercises the audio
 * SCHEDULING that makes a metronome usable — and guards it against regressions.
 *
 * It drives the buzzer's PWM handler with a metronome sequence (onset → note-off
 * pairs carrying their simulated timestamps) against a CONTROLLABLE audio clock,
 * and records the resulting Web-Audio schedule (one oscillator per click). Then
 * it asserts the qualities a metronome needs:
 *   - even onset spacing (steady tempo)
 *   - one oscillator per click, no overlap, strictly monotonic
 *   - correct pitch per metric level (accent vs beat)
 *   - bursty per-frame delivery is absorbed (still even)
 *   - a tempo change re-locks immediately and cleanly
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ComplexParts';
import { useSimulatorStore } from '../store/useSimulatorStore';

// ── Controllable audio clock + schedule recorder ─────────────────────────────
let clock = 0; // seconds; we advance it to emulate real time passing
type Ev = { kind: 'start' | 'stop'; when: number; freq?: number };
let sched: Ev[] = [];

function mockOscillator() {
  const o: any = {
    type: '',
    frequency: { value: 440, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
    onended: null,
    start: (w: number) => sched.push({ kind: 'start', when: w, freq: Math.round(o.frequency.value) }),
    stop: (w: number) => sched.push({ kind: 'stop', when: w }),
  };
  return o;
}
const gains: any[] = [];
function mockGain() {
  const g = {
    gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  gains.push(g);
  return g;
}
class MockAudioContext {
  state = 'running';
  destination = {};
  resume = vi.fn();
  close = vi.fn();
  get currentTime() {
    return clock;
  }
  createOscillator() {
    return mockOscillator();
  }
  createGain() {
    return mockGain();
  }
}

beforeEach(() => {
  clock = 0;
  sched = [];
  gains.length = 0;
  vi.stubGlobal('AudioContext', MockAudioContext as unknown as typeof AudioContext);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Metronome driver ─────────────────────────────────────────────────────────
const OCR2A = 0xb3;
const TCCR2B = 0xb1;
// OCR2A value for a target frequency (CTC, prescaler 64): f = 16e6/(2*64*(OCR+1)).
// Integer division, matching the firmware's `F_CPU/(2*64*freq) - 1`.
const ocrFor = (freq: number) => Math.floor(125000 / freq) - 1;
const ACCENT = ocrFor(1500); // 82 -> 1506 Hz
const BEAT = ocrFor(1100); //   112 -> 1106 Hz

// Every part attached by a test, torn down after it. The buzzer subscribes to
// the store now, so a part left attached goes on reacting to the NEXT test's
// state changes and scheduling stops for its own stale note.
const attached: Array<() => void> = [];
afterEach(() => {
  while (attached.length) attached.pop()!();
});

function setupBuzzer() {
  const sim: any = {
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
    pinManager: {
      onPinChange: vi.fn().mockReturnValue(() => {}),
    },
  };
  let pwm: ((pin: number, dc: number, timeMs?: number) => void) | null = null;
  sim.pinManager.onPwmChange = vi.fn().mockImplementation((_pin: number, cb: any) => {
    pwm = cb;
    return () => {};
  });
  const cleanup = PartSimulationRegistry.get('buzzer')!.attachEvents!(
    { addEventListener: vi.fn(), removeEventListener: vi.fn(), playing: false } as any,
    sim,
    (name: string) => (name === '1' ? 11 : null),
  );
  attached.push(cleanup);
  return { sim, cleanup, hit: (ocr: number, simMs: number, clickMs = 25) => {
    // onset: OCR set, PWM duty > 0 at simMs
    sim.cpu.data[OCR2A] = ocr;
    sim.cpu.data[TCCR2B] = 0x04; // CS22 -> prescaler 64
    clock = simMs / 1000;
    pwm!(11, ocr / 255, simMs);
    // note-off one click later
    clock = (simMs + clickMs) / 1000;
    pwm!(11, 0, simMs + clickMs);
  } };
}

// Pull the recorded notes (a start paired with its following stop).
function notes() {
  const out: { on: number; off: number; freq: number }[] = [];
  for (let i = 0; i + 1 < sched.length; i++) {
    if (sched[i].kind === 'start' && sched[i + 1].kind === 'stop') {
      out.push({ on: sched[i].when, off: sched[i + 1].when, freq: sched[i].freq! });
    }
  }
  return out;
}

describe('Buzzer — metronome quality', () => {
  it('plays an even metronome with an accent on the down-beat', () => {
    const { hit } = setupBuzzer();
    const beat = 500; // ms — quarter notes @ 120 BPM
    for (let i = 0; i < 8; i++) hit(i % 4 === 0 ? ACCENT : BEAT, i * beat);

    const ns = notes();
    expect(ns.length).toBe(8);
    // even spacing (steady tempo)
    for (let i = 1; i < ns.length; i++) {
      const gap = (ns[i].on - ns[i - 1].on) * 1000;
      expect(Math.abs(gap - beat)).toBeLessThan(5);
    }
    // one oscillator per click, no overlap, monotonic
    for (let i = 0; i < ns.length; i++) {
      expect(ns[i].off).toBeGreaterThan(ns[i].on);
      if (i > 0) {
        expect(ns[i].on).toBeGreaterThan(ns[i - 1].on);
        expect(ns[i - 1].off).toBeLessThanOrEqual(ns[i].on + 1e-6);
      }
    }
    // correct pitch per metric level
    expect(Math.abs(ns[0].freq - 1506)).toBeLessThanOrEqual(2); // accent
    expect(Math.abs(ns[1].freq - 1106)).toBeLessThanOrEqual(2); // beat
  });

  it('absorbs bursty per-frame delivery (onsets even in sim time, jittery in wall time)', () => {
    const { sim, cleanup } = setupBuzzer();
    void cleanup;
    let pwm!: (p: number, dc: number, t?: number) => void;
    sim.pinManager.onPwmChange.mock.calls; // noop ref
    // re-grab the callback captured during setup
    pwm = sim.pinManager.onPwmChange.mock.calls[0][1];

    const beat = 250; // even sim spacing
    // wall-clock delivery jitters by ~one 60fps frame each onset (a real burst)
    const wobble = [0, -15, 12, -10, 14, -13, 10, -8, 0, 11];
    for (let i = 0; i < 10; i++) {
      const simMs = i * beat;
      sim.cpu.data[OCR2A] = i % 4 === 0 ? ACCENT : BEAT;
      sim.cpu.data[TCCR2B] = 0x04;
      clock = (simMs + wobble[i]) / 1000; // jittery wall time
      pwm(11, 0.3, simMs);
      clock = (simMs + 25 + wobble[i]) / 1000;
      pwm(11, 0, simMs + 25);
    }
    const ns = notes();
    expect(ns.length).toBeGreaterThanOrEqual(8);
    // despite the wall-clock jitter, scheduled onsets stay even (de-jittered)
    for (let i = 2; i < ns.length; i++) {
      const gap = (ns[i].on - ns[i - 1].on) * 1000;
      expect(Math.abs(gap - beat)).toBeLessThan(20);
      expect(ns[i - 1].off).toBeLessThanOrEqual(ns[i].on + 1e-6); // no overlap
    }
  });

  it('re-locks immediately and cleanly when the tempo changes', () => {
    const { hit } = setupBuzzer();
    let t = 0;
    for (let i = 0; i < 5; i++) {
      hit(BEAT, t);
      t += 500;
    } // 120 BPM
    for (let i = 0; i < 6; i++) {
      hit(BEAT, t);
      t += 250;
    } // jump to 240 BPM

    const ns = notes();
    expect(ns.length).toBe(11);
    // no overlap / no backward note across the change
    for (let i = 1; i < ns.length; i++) {
      expect(ns[i].on).toBeGreaterThan(ns[i - 1].on);
      expect(ns[i - 1].off).toBeLessThanOrEqual(ns[i].on + 1e-6);
    }
    // settled to the new rate within a beat of the change (no drift/creep)
    const lastGap = (ns[ns.length - 1].on - ns[ns.length - 2].on) * 1000;
    expect(Math.abs(lastGap - 250)).toBeLessThan(10);
  });

  // Regression guard for the maintainer's review (PR #220, comment 4671821612):
  // a melody / continuous tone is consecutive tone(pin, freqN) calls with NO
  // noTone() between pitches — back-to-back nonzero OCR writes, each firing the
  // PWM handler with duty>0 and no intervening note-off. The old code overwrote
  // activeOsc on every pitch change without stopping the previous node, so
  // oscillators were "started but never stopped" — they stacked and played
  // forever. The monophonic guard must REPLACE the live note instead.
  it('replaces rather than stacks oscillators on a melody / continuous tone', () => {
    const { sim } = setupBuzzer();
    const pwm = sim.pinManager.onPwmChange.mock.calls[0][1] as (
      p: number,
      dc: number,
      t?: number,
    ) => void;

    // A little tune: pitch changes with no note-off between them (legato).
    const melody = [523, 587, 659, 698, 784, 659]; // C5 D5 E5 F5 G5 E5
    const step = 200; // ms per note
    melody.forEach((freq, i) => {
      sim.cpu.data[OCR2A] = ocrFor(freq);
      sim.cpu.data[TCCR2B] = 0x04; // CS22 -> prescaler 64
      clock = (i * step) / 1000;
      pwm(11, 0.5, i * step); // square-wave duty>0, pitch change, NO dc=0
    });
    // End the tune with a noTone — releases the final note.
    clock = (melody.length * step) / 1000;
    pwm(11, 0, melody.length * step);

    const starts = sched.filter((e) => e.kind === 'start');
    const stops = sched.filter((e) => e.kind === 'stop');

    // Every oscillator that started is stopped — no orphans left ringing. This
    // is the exact failure the maintainer saw ("started but never stopped: 6").
    expect(starts.length).toBe(melody.length);
    expect(stops.length).toBe(starts.length);

    // One start per note, at the right pitch, in order. Compare against the
    // CTC-reconstructed pitch (what the firmware's integer OCR actually yields),
    // not the nominal note — same round-trip the buzzer's getFrequency does.
    const heard = (freq: number) => Math.round(125000 / (ocrFor(freq) + 1));
    starts.forEach((s, i) => {
      expect(s.freq).toBe(heard(melody[i]));
      if (i > 0) expect(s.when).toBeGreaterThan(starts[i - 1].when); // monotonic, no backward
    });
    // Pitch is read FRESH per note (not stuck on the first onset): the tune rises
    // then falls, so the heard sequence is non-constant and tracks the melody.
    const heardSeq = starts.map((s) => s.freq);
    expect(new Set(heardSeq).size).toBeGreaterThan(1);
    expect(heardSeq).toEqual(melody.map(heard));

    // Bounded overlap (replacement, not stacking): each note is released close to
    // the NEXT note's onset — not smeared to the end of the tune. Pair each start
    // with its own stop (interleaved start/stop/start/stop… once the guard fires).
    const notesSeq: { on: number; off: number }[] = [];
    for (let i = 0; i + 1 < sched.length; i++) {
      if (sched[i].kind === 'start' && sched[i + 1].kind === 'stop') {
        notesSeq.push({ on: sched[i].when, off: sched[i + 1].when });
      }
    }
    expect(notesSeq.length).toBe(melody.length);
    for (let i = 0; i < notesSeq.length - 1; i++) {
      // old note ends as the next begins (≤ a release tail past the next onset)
      expect(notesSeq[i].off).toBeLessThanOrEqual(notesSeq[i + 1].on + 0.01);
      expect(notesSeq[i].off).toBeGreaterThan(notesSeq[i].on); // positive duration
    }
  });

  // A melody that ends WITHOUT a noTone() — the real "sketch loops tone() and
  // never calls noTone()" pattern. Correct Arduino semantics: a tone() plays
  // until noTone() or the NEXT tone(), so the final note must keep ringing. The
  // guard must release exactly the SUPERSEDED notes (one stop each) and leave the
  // last one sounding — not orphan the middle notes, not cut the last one short.
  it('releases superseded notes but leaves the final note ringing (no trailing noTone)', () => {
    const { sim } = setupBuzzer();
    const pwm = sim.pinManager.onPwmChange.mock.calls[0][1] as (
      p: number,
      dc: number,
      t?: number,
    ) => void;

    const melody = [440, 494, 523]; // A4 B4 C5
    const step = 200;
    melody.forEach((freq, i) => {
      sim.cpu.data[OCR2A] = ocrFor(freq);
      sim.cpu.data[TCCR2B] = 0x04;
      clock = (i * step) / 1000;
      pwm(11, 0.5, i * step); // pitch change, NO dc=0 — and no noTone at the end
    });

    const starts = sched.filter((e) => e.kind === 'start');
    const stops = sched.filter((e) => e.kind === 'stop');
    // Every note starts; only the superseded ones stop → exactly one note (the
    // last) is still live. Pre-guard this was starts=3, stops=0 (all orphaned).
    expect(starts.length).toBe(melody.length);
    expect(stops.length).toBe(starts.length - 1);
  });

  // ── Stop means silence ─────────────────────────────────────────────────
  // A buzzer sounds because a pin is driving it; when the board stops, nothing
  // is. Parts deliberately survive a Stop — a display keeps its picture — so
  // nothing ended the note, and the last tone played on until Reset remounted
  // the part. A user could only silence it by resetting (issue #351).
  it('ends the note when the board stops, without waiting for a reset', () => {
    const { sim } = setupBuzzer();
    useSimulatorStore.setState({ boards: [{ running: true }] as never });
    const pwm = (sim.pinManager.onPwmChange as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
      p: number,
      dc: number,
      t?: number,
    ) => void;

    sim.cpu.data[OCR2A] = ocrFor(440);
    sim.cpu.data[TCCR2B] = 0x04;
    clock = 0;
    pwm(11, 0.5, 0); // a tone with no note-off: it would ring for ever
    expect(sched.filter((e) => e.kind === 'start').length).toBe(1);
    expect(sched.filter((e) => e.kind === 'stop').length, 'still sounding').toBe(0);

    clock = 1;
    useSimulatorStore.setState({ boards: [{ running: false }] as never });
    expect(sched.filter((e) => e.kind === 'stop').length, 'the board stopped, so the note ended').toBe(1);
  });

  it('is quieter at a duty the pin barely moves through', () => {
    // A passive buzzer puts out the fundamental of the square wave driving it,
    // and that is loudest at 50% duty. analogWrite() on a buzzer is how people
    // control volume; tone(), a 50% square, must be unaffected.
    const { sim } = setupBuzzer();
    useSimulatorStore.setState({ boards: [{ running: true }] as never });
    const pwm = (sim.pinManager.onPwmChange as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
      p: number,
      dc: number,
      t?: number,
    ) => void;
    sim.cpu.data[OCR2A] = ocrFor(440);
    sim.cpu.data[TCCR2B] = 0x04;

    const peakOf = (duty: number, at: number) => {
      clock = at;
      pwm(11, duty, at * 1000);
      const g = gains[gains.length - 1];
      const ramp = g.gain.linearRampToValueAtTime.mock.calls.at(-1);
      return ramp ? (ramp[0] as number) : 0;
    };
    const half = peakOf(0.5, 0);
    const narrow = peakOf(0.1, 1);
    expect(half, 'a 50% square is the loudest a pin can drive').toBeGreaterThan(narrow);
    expect(narrow / half).toBeCloseTo(Math.sin(Math.PI * 0.1), 3);
  });

  it('leaves a buzzer alone while its own board is still running', () => {
    // Two boards on the canvas: stopping one must not cut off a tone the
    // other is still driving.
    const { sim } = setupBuzzer();
    useSimulatorStore.setState({ boards: [{ running: true }, { running: true }] as never });
    const pwm = (sim.pinManager.onPwmChange as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
      p: number,
      dc: number,
      t?: number,
    ) => void;
    sim.cpu.data[OCR2A] = ocrFor(440);
    sim.cpu.data[TCCR2B] = 0x04;
    pwm(11, 0.5, 0);
    useSimulatorStore.setState({ boards: [{ running: true }, { running: false }] as never });
    expect(sched.filter((e) => e.kind === 'stop').length).toBe(0);
  });
});
