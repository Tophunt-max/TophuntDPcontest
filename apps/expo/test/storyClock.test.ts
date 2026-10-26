/**
 * Story progress / auto-advance (src/lib/storyClock.ts) against a fake driver
 * with a manual clock, so each defect it replaces is reproduced exactly.
 */
import { describe, it, expect } from 'vitest';

import { StoryClock, type ProgressDriver } from '@/src/lib/storyClock';

/** A linear "animation": value advances with the manual clock while running. */
function fakeDriver() {
  let now = 0;
  let value = 0;
  let run: { from: number; at: number; duration: number; done: () => void } | null = null;
  const current = () => (run ? Math.min(1, run.from + (now - run.at) / run.duration * (1 - run.from)) : value);
  const driver: ProgressDriver = {
    set(v) {
      value = v;
      run = null;
    },
    run(duration, done) {
      run = { from: value, at: now, duration, done };
    },
    stop() {
      value = current();
      run = null;
      return value;
    },
  };
  return {
    driver,
    value: current,
    advance(ms: number) {
      now += ms;
      if (run && current() >= 1) {
        const r = run;
        value = 1;
        run = null;
        r.done();
      }
    },
    get runningFor() {
      return run?.duration ?? null;
    },
  };
}

function setup() {
  const d = fakeDriver();
  let finished = 0;
  const clock = new StoryClock(d.driver, () => finished++);
  return { d, clock, finished: () => finished };
}

describe('StoryClock', () => {
  it('runs a story for its duration, then advances once', () => {
    const { d, clock, finished } = setup();
    clock.reset('s1');
    clock.start(5_000);
    d.advance(4_999);
    expect(finished()).toBe(0);
    d.advance(1);
    expect(finished()).toBe(1);
  });

  it('does not run before the media is ready', () => {
    const { d, clock, finished } = setup();
    clock.reset('s1');
    d.advance(60_000);
    expect(finished()).toBe(0);
    expect(clock.isRunning).toBe(false);
  });

  it('resume continues from where it paused (it used to restart the full duration)', () => {
    const { d, clock, finished } = setup();
    clock.reset('s1');
    clock.start(10_000);
    d.advance(6_000);
    clock.hold('user');
    d.advance(30_000); // held: nothing moves
    expect(clock.progress).toBeCloseTo(0.6, 5);
    clock.release('user');
    expect(d.runningFor).toBe(4_000); // the remaining 40%, not 10 s
    d.advance(4_000);
    expect(finished()).toBe(1);
  });

  it('a video recovering from a stall does not reset the bar', () => {
    const { d, clock } = setup();
    clock.reset('v1');
    clock.start(10_000);
    d.advance(5_000);
    clock.hold('buffering');
    d.advance(3_000);
    clock.start(10_000); // readyToPlay again
    expect(clock.progress).toBeCloseTo(0.5, 5);
    expect(d.runningFor).toBe(5_000);
  });

  it('buffering pauses the bar, so a slow video is not skipped', () => {
    const { d, clock, finished } = setup();
    clock.reset('v1');
    clock.start(4_000);
    d.advance(1_000);
    clock.hold('buffering');
    d.advance(60_000);
    expect(finished()).toBe(0);
  });

  it('holds combine: releasing one does not resume while another is held', () => {
    const { clock } = setup();
    clock.reset('s1');
    clock.start(5_000);
    clock.hold('user');
    clock.hold('background');
    clock.release('user');
    expect(clock.isRunning).toBe(false);
    clock.release('background');
    expect(clock.isRunning).toBe(true);
  });

  it('ready while paused waits for the release (it used to never start)', () => {
    const { d, clock, finished } = setup();
    clock.reset('v1');
    clock.hold('user');
    clock.start(2_000);
    d.advance(10_000);
    expect(finished()).toBe(0);
    clock.release('user');
    d.advance(2_000);
    expect(finished()).toBe(1);
  });

  it('a new story starts from 0, and environment holds carry over', () => {
    const { d, clock } = setup();
    clock.reset('s1');
    clock.start(5_000);
    d.advance(2_500);
    clock.hold('background');
    clock.reset('s2');
    expect(clock.progress).toBe(0);
    clock.start(5_000);
    expect(clock.isRunning).toBe(false); // still in the background
    clock.release('background');
    expect(clock.isRunning).toBe(true);
  });

  it("a previous story's completion never advances the next one", () => {
    const d = fakeDriver();
    let finished = 0;
    const saved: Array<() => void> = [];
    const clock = new StoryClock(
      { ...d.driver, run: (ms, done) => saved.push(done) },
      () => finished++,
    );
    clock.reset('s1');
    clock.start(1_000);
    clock.reset('s2');
    saved[0](); // the old animation reports completion late
    expect(finished).toBe(0);
  });
});
