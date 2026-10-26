/**
 * The Story progress bar and auto-advance, as a small state machine.
 *
 * The viewer drove an `Animated.timing` directly, which had four defects:
 *  1. Resume restarted the FULL duration. The "progress so far" ref was only
 *     ever set to 0, so every long-press made the story longer and pushed the
 *     bar out of step with the video.
 *  2. Every `readyToPlay` restarted the bar from 0. A video that stalled and
 *     recovered mid-clip had its bar reset while playback continued.
 *  3. Nothing paused the bar while a video was buffering, so a slow video
 *     could be skipped before it was seen.
 *  4. Nothing paused it when the app went to the background or another screen
 *     covered the viewer.
 *
 * Model: a story has a duration and a progress value in [0, 1]. The bar runs
 * only when the story has STARTED and nothing HOLDS it. Holds are named, so the
 * user's long-press, buffering, the app being in the background and a sheet
 * being open combine correctly: releasing one does not resume while another is
 * still held.
 */

export type HoldReason = 'loading' | 'buffering' | 'user' | 'background' | 'blur';

/** What actually moves the bar. The viewer adapts an Animated.Value to this. */
export interface ProgressDriver {
  /** Jump to a value with no animation. */
  set(value: number): void;
  /** Animate from the current value to 1 over `durationMs`; call `onDone` only if it reached 1. */
  run(durationMs: number, onDone: () => void): void;
  /** Stop and report where it stopped. */
  stop(): number;
}

export class StoryClock {
  private value = 0;
  private durationMs = 0;
  private started = false;
  private running = false;
  private storyKey: string | null = null;
  private readonly holds = new Set<HoldReason>();
  /** Bumped per story so a stale animation's completion is ignored. */
  private generation = 0;

  constructor(
    private readonly driver: ProgressDriver,
    private readonly onFinish: () => void,
  ) {}

  /**
   * A new story is on screen. Progress goes to 0 and the bar waits for
   * `start()`. 'loading' is held until the media is ready. Holds that describe
   * the environment (user, background, blur) carry over.
   */
  reset(storyKey: string): void {
    this.halt();
    this.generation++;
    this.storyKey = storyKey;
    this.value = 0;
    this.durationMs = 0;
    this.started = false;
    this.holds.delete('buffering');
    this.holds.add('loading');
    this.driver.set(0);
  }

  /**
   * The media is ready and its length is known. Only the FIRST call per story
   * starts it; later calls (a video recovering from a stall) just release the
   * loading/buffering holds, so progress is never reset mid-story.
   */
  start(durationMs: number): void {
    if (!this.started) {
      this.started = true;
      this.durationMs = Math.max(1, durationMs);
    }
    this.holds.delete('loading');
    this.holds.delete('buffering');
    this.update();
  }

  hold(reason: HoldReason): void {
    if (this.holds.has(reason)) return;
    this.holds.add(reason);
    this.update();
  }

  release(reason: HoldReason): void {
    if (!this.holds.delete(reason)) return;
    this.update();
  }

  /** Set one hold from a boolean (for effects that track a flag). */
  setHeld(reason: HoldReason, held: boolean): void {
    if (held) this.hold(reason);
    else this.release(reason);
  }

  /** Stop everything (viewer closing). */
  dispose(): void {
    this.halt();
    this.generation++;
  }

  // ------------------------------------------------------------------ state

  get progress(): number {
    return this.value;
  }
  get isRunning(): boolean {
    return this.running;
  }
  get hasStarted(): boolean {
    return this.started;
  }
  isHeld(reason: HoldReason): boolean {
    return this.holds.has(reason);
  }
  get key(): string | null {
    return this.storyKey;
  }

  // ---------------------------------------------------------------- private

  private update(): void {
    const shouldRun = this.started && this.holds.size === 0 && this.value < 1;
    if (shouldRun && !this.running) this.resume();
    else if (!shouldRun && this.running) this.halt();
  }

  private resume(): void {
    this.running = true;
    const gen = this.generation;
    const remaining = Math.max(1, Math.round((1 - this.value) * this.durationMs));
    this.driver.run(remaining, () => {
      if (gen !== this.generation || !this.running) return;
      this.running = false;
      this.value = 1;
      this.onFinish();
    });
  }

  private halt(): void {
    if (!this.running) return;
    this.running = false;
    const v = this.driver.stop();
    if (Number.isFinite(v)) this.value = Math.min(1, Math.max(0, v));
  }
}
