import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock';
import { MemoryStore } from '../src/lib/storage';
import { JoeyOrtizCore, formatUptime, retryBackoffMs, WORKER_VERSION } from '../src/lib/worker/core';

/**
 * The whole point of JOEY ORTIZ is that it keeps working. Each test here
 * attacks the loop with one specific failure mode and asserts the loop is
 * still alive afterwards.
 */

const never = (): Promise<void> => new Promise<void>(() => undefined);

function makeCore(overrides: Partial<ConstructorParameters<typeof JoeyOrtizCore>[0]> = {}) {
  const clock = new FakeClock(1_000);
  const store = new MemoryStore();
  const core = new JoeyOrtizCore({ clock, store, ...overrides });
  return { clock, store, core };
}

describe('JoeyOrtizCore drains work', () => {
  it('processes the queue FIFO and marks tasks done', async () => {
    const seen: string[] = [];
    const runner = (task: { label: string }): void => {
      seen.push(task.label);
    };
    const worker = new JoeyOrtizCore({ clock: new FakeClock(), store: new MemoryStore(), runner });

    worker.enqueue('one');
    worker.enqueue('two');
    worker.enqueue('three');

    await worker.tick();
    await worker.tick();
    await worker.tick();

    expect(seen).toEqual(['one', 'two', 'three']);
    expect(worker.tasks.every((task) => task.state === 'done')).toBe(true);
    expect(worker.status().doneCount).toBe(3);
    expect(worker.status().queueDepth).toBe(0);
  });

  it('idles cleanly when there is nothing to do', async () => {
    const { core } = makeCore();
    const events: string[] = [];
    core.subscribe((event) => events.push(event.type));

    const completed = await core.tick();

    expect(completed).toBe(0);
    expect(events).toContain('idle');
    expect(core.status().ticks).toBe(1);
  });
});

describe('a throwing task cannot kill the loop', () => {
  it('retries with backoff, then parks the task and carries on', async () => {
    const clock = new FakeClock(0);
    let badCalls = 0;
    const runner = (task: { label: string }): void => {
      if (task.label === 'bad') {
        badCalls += 1;
        throw new Error('boom');
      }
    };
    const core = new JoeyOrtizCore({ clock, store: new MemoryStore(), runner, maxAttempts: 3 });

    core.enqueue('bad');
    core.enqueue('good');

    await core.tick(); // bad attempt 1 -> retry
    expect(badCalls).toBe(1);
    expect(core.tasks[0]?.state).toBe('queued');

    await core.tick(); // bad attempt 2 -> retry
    expect(badCalls).toBe(2);
    expect(core.tasks[0]?.state).toBe('queued');

    // attempt 2 carries a 1s backoff, so the loop serves 'good' in the meantime
    await core.tick();
    expect(core.tasks[1]?.state).toBe('done');

    clock.advance(1_000);
    await core.tick(); // bad attempt 3 -> parked
    expect(badCalls).toBe(3);
    expect(core.tasks[0]?.state).toBe('failed');
    expect(core.tasks[0]?.lastError).toBe('boom');

    // The loop is still healthy and still ticking.
    expect(core.status().failedCount).toBe(1);
    core.enqueue('after');
    await core.tick();
    expect(core.tasks[2]?.state).toBe('done');
  });

  it('survives a runner that throws a non-Error', async () => {
    const { core } = makeCore({
      runner: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string failure';
      },
      maxAttempts: 1,
    });

    core.enqueue('weird');
    await core.tick();

    expect(core.tasks[0]?.state).toBe('failed');
    expect(core.tasks[0]?.lastError).toBe('plain string failure');
    await expect(core.tick()).resolves.toBe(0);
  });
});

describe('a hanging task cannot kill the loop', () => {
  it('watchdog detects a stale heartbeat, reclaims the slot and re-queues', () => {
    const clock = new FakeClock(0);
    const core = new JoeyOrtizCore({
      clock,
      store: new MemoryStore(),
      runner: never,
      heartbeatMs: 100,
      stallAfterMs: 400,
      maxAttempts: 99,
    });

    core.start();
    core.enqueue('stuck');

    clock.advance(100); // tick 1 picks the task up and hangs inside the runner
    expect(core.tasks[0]?.state).toBe('running');
    expect(core.status().stalls).toBe(0);

    clock.advance(400); // ticks 2..6; the heartbeat goes stale partway through

    expect(core.status().stalls).toBeGreaterThanOrEqual(1);
    expect(core.status().recovers).toBeGreaterThanOrEqual(1);
    expect(core.status().stalled).toBe(false);
    // The task was reclaimed and put back in the queue rather than lost; the
    // same tick then picked it up again, so attempts is the durable evidence.
    expect(core.tasks[0]?.attempts).toBe(2);
    expect(core.tasks[0]?.lastError).toContain('reclaimed by watchdog');
    expect(core.status().ticks).toBeGreaterThan(1);
  });

  it('beat() lets a genuinely slow task outlive the watchdog threshold', async () => {
    const clock = new FakeClock(0);
    // Held in an object so control-flow analysis does not narrow it to null:
    // the assignment happens inside the promise executor.
    const holder: { release: (() => void) | null } = { release: null };
    const core = new JoeyOrtizCore({
      clock,
      store: new MemoryStore(),
      // A task that takes a long time but reports liveness throughout.
      runner: (task) =>
        new Promise<void>((resolve) => {
          holder.release = resolve;
          void task;
        }),
      heartbeatMs: 100,
      stallAfterMs: 400,
    });

    core.start();
    core.enqueue('slow but alive');
    clock.advance(100);
    expect(core.tasks[0]?.state).toBe('running');

    // 3s of wall time — far past stallAfterMs — but beating every 200ms.
    for (let i = 0; i < 15; i += 1) {
      clock.advance(200);
      core.beat();
    }
    expect(core.status().stalls).toBe(0);
    expect(core.status().recovers).toBe(0);
    expect(core.tasks[0]?.state).toBe('running');

    holder.release?.();
    await Promise.resolve();
    await core.tick();
    expect(core.tasks[0]?.state).toBe('done');
  });

  it('recover() is safe to call by hand at any time', async () => {
    const { core } = makeCore({ runner: never });
    core.enqueue('manual');
    // Not awaited: the runner never resolves. The synchronous prefix of tick()
    // still claims the task, which is all this test needs.
    void core.tick();
    expect(core.tasks[0]?.state).toBe('running');

    core.recover('manual intervention');

    expect(core.tasks[0]?.state).toBe('queued');
    expect(core.status().recovers).toBe(1);
    expect(core.status().stalled).toBe(false);
  });
});

describe('a storage failure cannot kill the loop', () => {
  it('counts persist failures and keeps processing', async () => {
    const store = new MemoryStore();
    store.failing = true;
    const core = new JoeyOrtizCore({ clock: new FakeClock(), store, runner: () => undefined });

    core.enqueue('resilient');
    await core.tick();

    expect(core.tasks[0]?.state).toBe('done');
    expect(core.status().persistFailures).toBeGreaterThan(0);

    core.enqueue('still going');
    await core.tick();
    expect(core.tasks[1]?.state).toBe('done');
  });
});

describe('survives the page dying', () => {
  it('restore() re-queues a task that was mid-flight when the tab closed', async () => {
    const store = new MemoryStore();
    const clockA = new FakeClock(0);
    const first = new JoeyOrtizCore({
      clock: clockA,
      store,
      runner: never,
      heartbeatMs: 100,
    });

    first.start();
    first.enqueue('crash victim');
    clockA.advance(100);
    expect(first.tasks[0]?.state).toBe('running');
    const ticksBeforeCrash = first.totalTicks;

    // --- the page dies here; a brand new core boots on the same storage ---
    const clockB = new FakeClock(99_000);
    const second = new JoeyOrtizCore({ clock: clockB, store, runner: () => undefined });

    const requeued = second.restore();

    expect(requeued).toBe(1);
    expect(second.tasks[0]?.state).toBe('queued');
    expect(second.tasks[0]?.lastError).toContain('unexpected shutdown');
    // Cumulative counters carry over; uptime restarts for the new session.
    expect(second.totalTicks).toBe(ticksBeforeCrash);
    expect(second.uptimeMs()).toBe(0);

    await second.tick();
    expect(second.tasks[0]?.state).toBe('done');
    expect(second.totalTicks).toBe(ticksBeforeCrash + 1);
  });

  it('restore() with no snapshot is a no-op', () => {
    const { core } = makeCore();
    expect(core.restore()).toBe(0);
  });

  it('does not re-allocate task ids after a restore', () => {
    const store = new MemoryStore();
    const first = new JoeyOrtizCore({ store, clock: new FakeClock() });
    first.enqueue('a');
    first.enqueue('b');

    const second = new JoeyOrtizCore({ store, clock: new FakeClock() });
    second.restore();
    const id = second.enqueue('c');

    expect(second.tasks.map((task) => task.id)).toEqual(['t1', 't2', 't3']);
    expect(id).toBe('t3');
  });

  it('stamps the snapshot with the running version', () => {
    const store = new MemoryStore();
    const core = new JoeyOrtizCore({ store, clock: new FakeClock() });
    core.enqueue('versioned');
    expect(core.snapshot().version).toBe(WORKER_VERSION);
  });
});

describe('a broken observer cannot kill the loop', () => {
  it('swallows a throwing subscriber', async () => {
    const { core } = makeCore({ runner: () => undefined });
    core.subscribe(() => {
      throw new Error('bad observer');
    });

    core.enqueue('observed');
    await core.tick();

    expect(core.tasks[0]?.state).toBe('done');
  });
});

describe('the loop runs on the injected clock', () => {
  it('start() ticks repeatedly and stop() ends it', async () => {
    const { clock, core } = makeCore({ runner: () => undefined });
    core.enqueue('a');
    core.enqueue('b');

    core.start();
    expect(core.running).toBe(true);

    clock.advance(300); // three ticks at heartbeatMs=1000? no: default 1000
    expect(core.status().ticks).toBe(0);

    clock.advance(3_000);
    expect(core.status().ticks).toBeGreaterThanOrEqual(3);

    core.stop();
    expect(core.running).toBe(false);
    const ticksAtStop = core.status().ticks;
    clock.advance(5_000);
    expect(core.status().ticks).toBe(ticksAtStop);
  });

  it('start() is idempotent', () => {
    const { clock, core } = makeCore();
    core.start();
    core.start();
    expect(clock.pendingTimers).toBe(1);
    core.stop();
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('backoff schedule', () => {
  it('grows quadratically from zero', () => {
    expect(retryBackoffMs(0)).toBe(0);
    expect(retryBackoffMs(1)).toBe(0);
    expect(retryBackoffMs(2)).toBe(1_000);
    expect(retryBackoffMs(3)).toBe(4_000);
    expect(retryBackoffMs(4)).toBe(9_000);
  });
});

describe('log ring buffer', () => {
  it('caps retained entries at maxLog', async () => {
    const { core } = makeCore({ runner: () => undefined, maxLog: 5 });
    for (let i = 0; i < 12; i += 1) core.enqueue(`task-${i}`);
    for (let i = 0; i < 12; i += 1) await core.tick();

    expect(core.log.length).toBeLessThanOrEqual(5);
  });
});

describe('formatUptime', () => {
  it('renders hh:mm:ss', () => {
    expect(formatUptime(0)).toBe('00:00:00');
    expect(formatUptime(9_999)).toBe('00:00:09');
    expect(formatUptime(65_000)).toBe('00:01:05');
    expect(formatUptime(3_725_000)).toBe('01:02:05');
  });

  it('never goes negative', () => {
    expect(formatUptime(-5_000)).toBe('00:00:00');
  });
});
