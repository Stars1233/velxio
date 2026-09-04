/**
 * LineTimeline — the ledger of host-originated pad edges on one board, and
 * the one place that answers whether the board's clock may skip right now.
 *
 * WHAT IT IS FOR. A line-owning sensor answers the guest with a complete
 * waveform: a train of edges at exact guest-time instants. Three engine
 * families deliver those edges three ways (a sorted queue flushed after every
 * instruction, a min-heap the engine applies in step(), a WebSocket to a
 * worker), and each one also has a mechanism that advances simulated time
 * WITHOUT retiring the guest's instructions: a WAITI/WFI skip, a busy-spin
 * elision, a never-idle catch-up. Every such mechanism has to obey the same
 * rule, and until this file the rule was implemented three times, privately,
 * and once with a sensor's name in it. The ledger is engine-agnostic: it only
 * ever sees frames and cycle counts.
 *
 * THE RULE, stated once, without naming a device:
 *
 *   A mechanism that advances guest time without retiring the guest's
 *   instructions may advance only across an interval the guest cannot
 *   measure.
 *
 *   (a) FENCE. Never past a pending host-originated edge. Skipping over an
 *       edge would deliver it late or not at all.
 *   (b) FLOOR. Not at all while a self-timed frame is open, from the cycle it
 *       is queued to the cycle of its last edge. Inside that window the
 *       guest's only clock may be the instructions it retires: a driver that
 *       measures a pulse by COUNTING loop iterations reads no timer, so no
 *       deadline exists for the fence to clamp on, and a skip that lands one
 *       cycle before each edge and then runs a fixed number of instructions
 *       makes every pulse, whatever its width, count the same. Measured with
 *       Adafruit DHT.h on esp32js: 4/4 reads good without the catch-up, 0/4
 *       with it, at ANY number of instructions per skip.
 *   (c) IDLE EXEMPTION. A halted core — WAITI/WFI, or a spin proven free of
 *       side effects — retires no instructions, so compressing its time can
 *       change no count. The floor does not apply to it; the fence still
 *       does. This clause is not a detail: arduino-pico's delay() SLEEPS,
 *       and a DHT22 read has delays inside it. Without the exemption the
 *       floor would freeze the Pico in the middle of every read.
 *
 * WHAT MAKES A FRAME SELF-TIMED is derived from its SHAPE, not from what
 * sensor produced it: more than two edges. Two edges are one interval whose
 * endpoints are both fenced, which a clock-reading guest measures exactly;
 * three or more mean the guest must resolve each edge against the last, and
 * only executing gets it there. The derived rule reproduces, unprompted, the
 * two decisions that were measured separately before it existed: the DHT22's
 * 84-edge frame holds the catch-up for its own ~5 ms, and the HC-SR04's 2-edge
 * echo keeps its catch-up rather than losing up to 24 ms per ping. A model may
 * set `selfTimed` explicitly, but only with a measurement behind it.
 *
 * THE HOLD IS DATA, NOT A QUERY. The model declares the frame as it schedules
 * it; the engine loop reads only `maySkip(now)` against its own cycle count.
 * Neither side knows what the other is.
 *
 * DELIVERY IS NOT DONE HERE. Each simulator already applies edges its own
 * way; the timeline forwards every edge to the host's `scheduleEdge` at emit
 * time and keeps only the bookkeeping the policy needs. A backwards cycle
 * count means the guest rebooted inside the engine with no hook fired (an
 * `esp_restart`): every open frame is forgotten, because a gate left in the
 * old base would hold for the previous uptime.
 */

export interface HostEdge {
  level: boolean;
  /** Absolute guest cycle to apply the edge at. */
  atCycle: number;
}

/** One host-originated utterance on one line: a complete waveform. */
export interface HostEdgeFrame {
  pin: number;
  /** Ascending by `atCycle`. */
  edges: ReadonlyArray<HostEdge>;
  /**
   * Hand the pad back to the guest at this cycle. Required on a shared
   * open-drain line: while the host drives a pad it outranks the guest, and a
   * sensor that keeps holding the line makes the guest's NEXT start signal
   * unobservable — it answers once per boot and every later read times out.
   */
  releaseAtCycle?: number;
  /**
   * Override the derived floor rule. Only with a measurement: `true` on a
   * two-edge frame a counting driver reads, `false` on a long frame that a
   * timer-reading driver decodes and that must not hold a never-idle sketch.
   */
  selfTimed?: boolean;
}

/** Where the frames' edges go. Each simulator provides its own. */
export interface EdgeSink {
  scheduleEdge(pin: number, level: boolean, atCycle: number): void;
  /** Optional: an engine that models host ownership of a pad. */
  scheduleRelease?(pin: number, atCycle: number): void;
}

interface OpenFrame {
  pin: number;
  /** First cycle at which the frame is on the wire. */
  from: number;
  /** Last edge cycle. */
  to: number;
  edges: ReadonlyArray<HostEdge>;
  selfTimed: boolean;
}

/** Edges above this count make a frame self-timed by default (see header). */
export const SELF_TIMED_EDGE_THRESHOLD = 2;

/** Guest cycles of slack kept past a frame's last edge before it closes. */
const CLOSE_MARGIN_CYCLES = 0;

export class LineTimeline {
  private readonly frames: OpenFrame[] = [];
  private lastSeen = -Infinity;
  private readonly sink: EdgeSink;

  constructor(sink: EdgeSink) {
    this.sink = sink;
  }

  /**
   * Queue a whole frame. Every edge is handed to the sink at once; the ledger
   * keeps the window. Returns the cycle of the frame's last edge.
   */
  emit(frame: HostEdgeFrame, nowCycle: number): number {
    this.observe(nowCycle);
    if (frame.edges.length === 0) return nowCycle;
    let last = -Infinity;
    for (const e of frame.edges) {
      if (e.atCycle < last) {
        throw new Error(
          `LineTimeline: edges must be ascending (pin ${frame.pin}: ${e.atCycle} after ${last})`,
        );
      }
      last = e.atCycle;
      this.sink.scheduleEdge(frame.pin, e.level, e.atCycle);
    }
    if (frame.releaseAtCycle !== undefined) {
      this.sink.scheduleRelease?.(frame.pin, frame.releaseAtCycle);
    }
    const selfTimed = frame.selfTimed ?? frame.edges.length > SELF_TIMED_EDGE_THRESHOLD;
    this.frames.push({
      pin: frame.pin,
      from: nowCycle,
      to: Math.max(last, frame.releaseAtCycle ?? last) + CLOSE_MARGIN_CYCLES,
      edges: frame.edges,
      selfTimed,
    });
    return last;
  }

  /**
   * Cycles from `nowCycle` to the earliest edge not yet due, or Infinity when
   * nothing is pending. THE FENCE: a skip must stop here.
   */
  cyclesUntilNextEdge(nowCycle: number): number {
    this.observe(nowCycle);
    let best = Infinity;
    for (const f of this.frames) {
      for (const e of f.edges) {
        if (e.atCycle > nowCycle) {
          const d = e.atCycle - nowCycle;
          if (d < best) best = d;
          break; // edges are ascending: the first pending one is the nearest
        }
      }
    }
    return best;
  }

  /**
   * May a time-skipping mechanism advance the clock at `nowCycle` while the
   * guest is EXECUTING? False while any self-timed frame is open. THE FLOOR.
   *
   * Not for an idle core: a WAITI/WFI skip retires nothing and is bound only
   * by the fence — see clause (c) in the header.
   */
  maySkip(nowCycle: number): boolean {
    this.observe(nowCycle);
    for (const f of this.frames) {
      if (f.selfTimed && nowCycle >= f.from && nowCycle < f.to) return false;
    }
    return true;
  }

  /**
   * The skip a mechanism is allowed at `nowCycle`: 0 while the floor holds,
   * else `want` clamped to the fence. One expression for every engine loop.
   */
  skipBudget(want: number, nowCycle: number): number {
    if (want <= 0) return 0;
    if (!this.maySkip(nowCycle)) return 0;
    const fence = this.cyclesUntilNextEdge(nowCycle);
    return Math.max(0, Math.min(want, fence));
  }

  /** True while a frame on `pin` still has an edge pending or is open. */
  ownsPin(pin: number, nowCycle: number): boolean {
    this.observe(nowCycle);
    return this.frames.some((f) => f.pin === pin && nowCycle < f.to);
  }

  /** True while any frame is open on any pin. */
  get busy(): boolean {
    return this.frames.length > 0;
  }

  /** Forget everything: run start, and whenever the cycle counter restarts. */
  reset(): void {
    this.frames.length = 0;
    this.lastSeen = -Infinity;
  }

  /**
   * Drop frames whose last edge is past. Every query prunes first, and a
   * counter that went backwards is a reboot: forget every frame.
   */
  private observe(nowCycle: number): void {
    if (nowCycle < this.lastSeen) {
      this.frames.length = 0;
    }
    this.lastSeen = nowCycle;
    if (this.frames.length === 0) return;
    let w = 0;
    for (let r = 0; r < this.frames.length; r++) {
      const f = this.frames[r];
      if (nowCycle < f.to) this.frames[w++] = f;
    }
    this.frames.length = w;
  }
}
