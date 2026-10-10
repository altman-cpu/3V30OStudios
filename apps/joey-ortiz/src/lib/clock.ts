/**
 * Injectable time source.
 *
 * The worker must be testable without waiting on real milliseconds, so every
 * time read in the runtime goes through a `Clock`. Production passes
 * `systemClock`; tests pass a fake that only moves when the test says so.
 */
export interface Clock {
  now(): number;
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export interface TimerHandle {
  readonly id: unknown;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (fn, ms) => ({ id: setInterval(fn, ms) }),
  cancel: (handle) => clearInterval(handle.id as ReturnType<typeof setInterval>),
};

/**
 * A clock whose time only advances when the test advances it.
 *
 * `schedule` mirrors systemClock's setInterval semantics: the callback
 * re-arms at the same period after every firing. A one-shot fake here would
 * silently turn loop tests into single-tick tests.
 */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, { dueAt: number; period: number; fn: () => void }>();

  constructor(startAt = 0) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  schedule(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.current + ms, period: ms, fn });
    return { id };
  }

  cancel(handle: TimerHandle): void {
    this.timers.delete(handle.id as number);
  }

  /** Move time forward, firing every timer that comes due along the way. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let next: { id: number; dueAt: number; period: number; fn: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.dueAt > target) continue;
        if (!next || timer.dueAt < next.dueAt) next = { id, ...timer };
      }
      if (!next) break;
      this.current = next.dueAt;
      // Re-arm before running, matching setInterval: a callback that cancels
      // its own timer still wins, because cancel() removes the new entry.
      if (next.period > 0) {
        this.timers.set(next.id, { dueAt: next.dueAt + next.period, period: next.period, fn: next.fn });
      } else {
        this.timers.delete(next.id);
      }
      next.fn();
    }
    this.current = target;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}
