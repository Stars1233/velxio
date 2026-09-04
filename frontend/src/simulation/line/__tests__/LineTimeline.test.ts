/**
 * The clock rule, as law: every clause with a negative control, so a future
 * edit that weakens a clause fails a test whose name says which one.
 */
import { describe, expect, it, vi } from 'vitest';
import { LineTimeline, SELF_TIMED_EDGE_THRESHOLD, type EdgeSink } from '../LineTimeline';

function makeSink(): EdgeSink & { edges: Array<[number, boolean, number]>; releases: Array<[number, number]> } {
  const sink = {
    edges: [] as Array<[number, boolean, number]>,
    releases: [] as Array<[number, number]>,
    scheduleEdge(pin: number, level: boolean, atCycle: number) {
      sink.edges.push([pin, level, atCycle]);
    },
    scheduleRelease(pin: number, atCycle: number) {
      sink.releases.push([pin, atCycle]);
    },
  };
  return sink;
}

const threeEdges = (pin: number, t0: number) => ({
  pin,
  edges: [
    { level: false, atCycle: t0 + 100 },
    { level: true, atCycle: t0 + 200 },
    { level: false, atCycle: t0 + 300 },
  ],
});
const twoEdges = (pin: number, t0: number) => ({
  pin,
  edges: [
    { level: true, atCycle: t0 + 100 },
    { level: false, atCycle: t0 + 300 },
  ],
});

describe('LineTimeline: delivery', () => {
  it('hands every edge to the sink at emit time, in order, and the release after them', () => {
    const sink = makeSink();
    const tl = new LineTimeline(sink);
    const last = tl.emit({ ...threeEdges(4, 1000), releaseAtCycle: 1350 }, 1000);
    expect(last).toBe(1300);
    expect(sink.edges).toEqual([
      [4, false, 1100],
      [4, true, 1200],
      [4, false, 1300],
    ]);
    expect(sink.releases).toEqual([[4, 1350]]);
  });

  it('refuses a frame whose edges are not ascending', () => {
    const tl = new LineTimeline(makeSink());
    expect(() =>
      tl.emit({ pin: 1, edges: [{ level: true, atCycle: 200 }, { level: false, atCycle: 100 }] }, 0),
    ).toThrow(/ascending/);
  });

  it('an empty frame is a no-op', () => {
    const sink = makeSink();
    const tl = new LineTimeline(sink);
    expect(tl.emit({ pin: 1, edges: [] }, 50)).toBe(50);
    expect(sink.edges).toEqual([]);
    expect(tl.busy).toBe(false);
  });
});

describe('LineTimeline: (a) the fence', () => {
  it('reports the cycles to the nearest pending edge across frames and pins', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 1000), 1000);
    tl.emit({ pin: 7, edges: [{ level: true, atCycle: 1150 }] }, 1000);
    expect(tl.cyclesUntilNextEdge(1000)).toBe(100);
    expect(tl.cyclesUntilNextEdge(1120)).toBe(30); // pin 7's edge at 1150
    expect(tl.cyclesUntilNextEdge(1250)).toBe(50);
    expect(tl.cyclesUntilNextEdge(1300)).toBe(Infinity); // the edge AT now is due, not pending
  });

  it('skipBudget never crosses the fence', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(twoEdges(4, 1000), 1000); // not self-timed: the floor is open
    expect(tl.skipBudget(1_000_000, 1000)).toBe(100);
    expect(tl.skipBudget(50, 1000)).toBe(50);
    expect(tl.skipBudget(1_000_000, 1100)).toBe(200);
  });

  it('negative control: with nothing pending the budget is the whole request', () => {
    const tl = new LineTimeline(makeSink());
    expect(tl.cyclesUntilNextEdge(0)).toBe(Infinity);
    expect(tl.skipBudget(1_000_000, 0)).toBe(1_000_000);
  });
});

describe('LineTimeline: (b) the floor', () => {
  it('holds while a self-timed frame is open, from emit to its last edge', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 1000), 1000);
    expect(tl.maySkip(1000)).toBe(false);
    expect(tl.maySkip(1150)).toBe(false);
    expect(tl.skipBudget(10, 1150)).toBe(0);
    expect(tl.maySkip(1299)).toBe(false);
    expect(tl.maySkip(1300)).toBe(true);
  });

  it('a frame with more than SELF_TIMED_EDGE_THRESHOLD edges is self-timed by shape', () => {
    expect(SELF_TIMED_EDGE_THRESHOLD).toBe(2);
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 0), 0);
    expect(tl.maySkip(50)).toBe(false);
  });

  it('negative control: a two-edge frame does NOT hold the floor (a fenced interval a clock reads exactly)', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(twoEdges(4, 0), 0);
    expect(tl.maySkip(50)).toBe(true);
    expect(tl.skipBudget(1000, 50)).toBe(50); // fenced, not floored
  });

  it('an explicit selfTimed overrides the shape both ways', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit({ ...twoEdges(4, 0), selfTimed: true }, 0);
    expect(tl.maySkip(50)).toBe(false);
    const tl2 = new LineTimeline(makeSink());
    tl2.emit({ ...threeEdges(4, 0), selfTimed: false }, 0);
    expect(tl2.maySkip(50)).toBe(true);
  });

  it('a release after the last edge extends the window to the release', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit({ ...threeEdges(4, 0), releaseAtCycle: 400 }, 0);
    expect(tl.maySkip(350)).toBe(false);
    expect(tl.ownsPin(4, 350)).toBe(true);
    expect(tl.maySkip(400)).toBe(true);
    expect(tl.ownsPin(4, 400)).toBe(false);
  });
});

describe('LineTimeline: pruning and reboot', () => {
  it('forgets a frame once its window is past', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 0), 0);
    expect(tl.busy).toBe(true);
    tl.maySkip(300);
    expect(tl.busy).toBe(false);
  });

  it('forgets every frame when the cycle counter goes backwards (a guest reboot inside the engine)', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 1_000_000_000), 1_000_000_000);
    expect(tl.maySkip(1_000_000_050)).toBe(false);
    expect(tl.maySkip(1000)).toBe(true); // rebooted: cycles restarted
    expect(tl.busy).toBe(false);
    expect(tl.cyclesUntilNextEdge(1000)).toBe(Infinity);
  });

  it('negative control: a counter that only moves forward keeps the frame', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 1000), 1000);
    tl.maySkip(1100);
    tl.maySkip(1200);
    expect(tl.busy).toBe(true);
  });

  it('reset() forgets everything', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 0), 0);
    tl.reset();
    expect(tl.busy).toBe(false);
    expect(tl.maySkip(10)).toBe(true);
  });

  it('ownsPin is per pin and per window', () => {
    const tl = new LineTimeline(makeSink());
    tl.emit(threeEdges(4, 0), 0);
    expect(tl.ownsPin(4, 10)).toBe(true);
    expect(tl.ownsPin(5, 10)).toBe(false);
    expect(tl.ownsPin(4, 300)).toBe(false);
  });

  it('does not call the sink for bookkeeping queries', () => {
    const sink = makeSink();
    const spy = vi.spyOn(sink, 'scheduleEdge');
    const tl = new LineTimeline(sink);
    tl.emit(threeEdges(4, 0), 0);
    spy.mockClear();
    tl.maySkip(10);
    tl.cyclesUntilNextEdge(10);
    tl.skipBudget(5, 10);
    tl.ownsPin(4, 10);
    expect(spy).not.toHaveBeenCalled();
  });
});
