/**
 * JOEY ORTIZ CORE — v0.0.1
 *
 * A single-purpose work loop whose only real requirement is that it keeps
 * working. Everything else is a feature; survivability is the spec.
 *
 * Three failure modes are handled explicitly:
 *
 *   1. A task throws.   -> attempts++, backoff, re-queue; after maxAttempts it
 *                          is parked as `failed` and THE LOOP CONTINUES.
 *   2. A task hangs.    -> the watchdog notices the heartbeat has gone stale,
 *                          reclaims the slot, re-queues the task, and resumes.
 *   3. The page dies.   -> every state change is snapshotted; on boot,
 *                          `restore()` rehydrates and re-queues anything that
 *                          was mid-flight when the tab closed.
 *
 * A storage failure is never fatal: persistence is best-effort and its failures
 * are counted, not thrown.
 */

import type { Clock } from '../clock';
import { systemClock } from '../clock';
import type { SnapshotStore } from '../storage';
import { MemoryStore } from '../storage';

export const WORKER_VERSION = '0.0.1';
export const SNAPSHOT_KEY = 'worker';

export type TaskState = 'queued' | 'running' | 'done' | 'failed';

export interface Task {
  id: string;
  label: string;
  payload: string;
  attempts: number;
  state: TaskState;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
}

export interface WorkerSnapshot {
  version: string;
  seq: number;
  startedAt: number;
  ticks: number;
  stalls: number;
  recovers: number;
  persistFailures: number;
  lastHeartbeatAt: number;
  lastTickAt: number;
  tasks: Task[];
  log: LogEntry[];
}

export type WorkerEvent =
  | { type: 'tick'; at: number }
  | { type: 'idle'; at: number }
  | { type: 'task:queued'; task: Task; at: number }
  | { type: 'task:start'; task: Task; at: number }
  | { type: 'task:done'; task: Task; at: number }
  | { type: 'task:retry'; task: Task; at: number; error: string }
  | { type: 'task:failed'; task: Task; at: number; error: string }
  | { type: 'stall'; at: number; sinceMs: number }
  | { type: 'recover'; at: number; reason: string }
  | { type: 'restored'; at: number; requeued: number }
  | { type: 'persist-failed'; at: number };

export type Runner = (task: Task) => void | Promise<void>;

export interface JoeyOptions {
  clock?: Clock;
  store?: SnapshotStore;
  runner?: Runner;
  /** Loop period. Also the heartbeat period. */
  heartbeatMs?: number;
  /** Heartbeat age past which the watchdog force-recovers the loop. */
  stallAfterMs?: number;
  maxAttempts?: number;
  maxLog?: number;
  snapshotKey?: string;
  onEvent?: (event: WorkerEvent) => void;
}

const DEFAULTS = {
  heartbeatMs: 1000,
  stallAfterMs: 6000,
  maxAttempts: 3,
  maxLog: 200,
} as const;

/** Backoff before the next retry of a task: 0, 1s, 4s, 9s, ... */
export function retryBackoffMs(attempt: number): number {
  const n = Math.max(0, attempt - 1);
  return n * n * 1000;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export interface WorkerStatus {
  running: boolean;
  stalled: boolean;
  busy: boolean;
  uptimeMs: number;
  ticks: number;
  stalls: number;
  recovers: number;
  persistFailures: number;
  queueDepth: number;
  doneCount: number;
  failedCount: number;
  heartbeatAgeMs: number;
  lastError: string | null;
}

export class JoeyOrtizCore {
  private readonly clock: Clock;
  private readonly store: SnapshotStore;
  private readonly runner: Runner;
  private readonly heartbeatMs: number;
  private readonly stallAfterMs: number;
  private readonly maxAttempts: number;
  private readonly maxLog: number;
  private readonly snapshotKey: string;
  private readonly onEvent: ((event: WorkerEvent) => void) | null;

  private state: WorkerSnapshot;
  private timer: ReturnType<Clock['schedule']> | null = null;
  private busy = false;
  private listeners = new Set<(event: WorkerEvent) => void>();
  private nextTaskId = 1;
  private stalled = false;

  constructor(options: JoeyOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.store = options.store ?? new MemoryStore();
    this.runner = options.runner ?? (() => undefined);
    this.heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
    this.stallAfterMs = options.stallAfterMs ?? DEFAULTS.stallAfterMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.maxLog = options.maxLog ?? DEFAULTS.maxLog;
    this.snapshotKey = options.snapshotKey ?? SNAPSHOT_KEY;
    this.onEvent = options.onEvent ?? null;

    const now = this.clock.now();
    this.state = {
      version: WORKER_VERSION,
      seq: 0,
      startedAt: now,
      ticks: 0,
      stalls: 0,
      recovers: 0,
      persistFailures: 0,
      lastHeartbeatAt: now,
      lastTickAt: now,
      tasks: [],
      log: [],
    };
  }

  // ---------------------------------------------------------------- events

  subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: WorkerEvent): void {
    // A broken observer must never take the loop down with it.
    try {
      this.onEvent?.(event);
    } catch {
      /* ignore */
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  private record(level: LogLevel, message: string): void {
    const entry: LogEntry = { at: this.clock.now(), level, message };
    this.state.log.push(entry);
    if (this.state.log.length > this.maxLog) {
      this.state.log.splice(0, this.state.log.length - this.maxLog);
    }
  }

  // ----------------------------------------------------------------- queue

  enqueue(label: string, payload = ''): string {
    const now = this.clock.now();
    const task: Task = {
      id: `t${this.nextTaskId++}`,
      label,
      payload,
      attempts: 0,
      state: 'queued',
      lastError: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.state.tasks.push(task);
    this.bump();
    this.persist();
    this.emit({ type: 'task:queued', task, at: now });
    return task.id;
  }

  get tasks(): readonly Task[] {
    return this.state.tasks;
  }

  get log(): readonly LogEntry[] {
    return this.state.log;
  }

  // ------------------------------------------------------------------ loop

  start(): void {
    if (this.timer !== null) return;
    this.state.lastHeartbeatAt = this.clock.now();
    this.timer = this.clock.schedule(() => {
      // The scheduler must never be able to kill the loop. tick() is async, so
      // both a synchronous throw and a rejected promise have to be caught.
      try {
        Promise.resolve(this.tick()).catch((error: unknown) => {
          this.record('error', `tick rejected: ${describeError(error)}`);
        });
      } catch (error) {
        this.record('error', `tick escaped: ${describeError(error)}`);
      }
    }, this.heartbeatMs);
    this.record('info', `JOEY ORTIZ v${WORKER_VERSION} loop started`);
    this.persist();
  }

  stop(): void {
    if (this.timer === null) return;
    this.clock.cancel(this.timer);
    this.timer = null;
    this.record('info', 'loop stopped');
    this.persist();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * One loop iteration: run the watchdog, then pull one task if a slot is free.
   * Returns the number of tasks that completed on this tick.
   */
  async tick(): Promise<number> {
    const now = this.clock.now();
    this.state.ticks += 1;
    this.state.lastTickAt = now;
    this.watchdog(now);
    this.emit({ type: 'tick', at: now });

    if (this.busy) return 0;

    const task = this.nextRunnable(now);
    if (!task) {
      this.heartbeat(now);
      this.emit({ type: 'idle', at: now });
      return 0;
    }

    this.busy = true;
    task.state = 'running';
    task.attempts += 1;
    task.updatedAt = now;
    this.bump();
    this.persist();
    this.emit({ type: 'task:start', task, at: now });

    let completed = 0;
    try {
      await this.runner(task);
      this.settle(task, 'done', null);
      completed = 1;
    } catch (error) {
      this.settle(task, 'retry', describeError(error));
    } finally {
      // Releasing the slot is unconditional: a failure or even a hung settle
      // must not leave the loop permanently busy.
      this.busy = false;
      this.heartbeat(this.clock.now());
    }

    this.persist();
    return completed;
  }

  /**
   * The watchdog. If the heartbeat is stale — meaning a tick has been stuck far
   * longer than it should be — reclaim the slot, put the stuck task back in the
   * queue, and keep going. A hung promise cannot be cancelled from here; what
   * this does is guarantee the *loop* is never held hostage by one.
   */
  private watchdog(now: number): void {
    const age = now - this.state.lastHeartbeatAt;
    if (age <= this.stallAfterMs) return;

    this.state.stalls += 1;
    this.stalled = true;
    this.emit({ type: 'stall', at: now, sinceMs: age });
    this.record('warn', `watchdog: heartbeat stale by ${age}ms`);
    this.recover('watchdog');
  }

  /**
   * Report liveness from inside a long-running task.
   *
   * Speaking a caption line takes seconds, which is longer than the watchdog
   * threshold. A task that is genuinely working calls beat() so the watchdog
   * can tell "slow" apart from "hung" — otherwise legitimate work would be
   * reclaimed out from under itself.
   */
  beat(): void {
    this.heartbeat(this.clock.now());
  }

  /** Force the loop back to a healthy state. Safe to call at any time. */
  recover(reason: string): void {
    const now = this.clock.now();
    let requeued = 0;
    for (const task of this.state.tasks) {
      if (task.state !== 'running') continue;
      task.state = 'queued';
      task.updatedAt = now;
      task.lastError = `reclaimed by watchdog (${reason})`;
      requeued += 1;
    }
    this.busy = false;
    this.stalled = false;
    this.state.recovers += 1;
    this.heartbeat(now);
    this.bump();
    this.persist();
    this.record('warn', `recovered (${reason}): re-queued ${requeued} task(s)`);
    this.emit({ type: 'recover', at: now, reason });
  }

  private settle(task: Task, outcome: 'done' | 'retry', error: string | null): void {
    const now = this.clock.now();
    task.updatedAt = now;

    if (outcome === 'done') {
      task.state = 'done';
      task.lastError = null;
      task.finishedAt = now;
      this.record('info', `done: ${task.label}`);
      this.emit({ type: 'task:done', task, at: now });
      return;
    }

    task.lastError = error;
    if (task.attempts >= this.maxAttempts) {
      task.state = 'failed';
      task.finishedAt = now;
      this.record('error', `parked after ${task.attempts} attempts: ${task.label} — ${error}`);
      this.emit({ type: 'task:failed', task, at: now, error: error ?? 'unknown' });
      return;
    }

    task.state = 'queued';
    this.record('warn', `retry ${task.attempts}/${this.maxAttempts - 1}: ${task.label} — ${error}`);
    this.emit({ type: 'task:retry', task, at: now, error: error ?? 'unknown' });
  }

  /** FIFO selection, honouring the backoff window after a failed attempt. */
  private nextRunnable(now: number): Task | undefined {
    for (const task of this.state.tasks) {
      if (task.state !== 'queued') continue;
      if (now - task.updatedAt < retryBackoffMs(task.attempts)) continue;
      return task;
    }
    return undefined;
  }

  private heartbeat(now: number): void {
    this.state.lastHeartbeatAt = now;
    this.stalled = false;
  }

  private bump(): void {
    this.state.seq += 1;
  }

  // ------------------------------------------------------------ persistence

  private persist(): void {
    try {
      this.store.write(this.snapshotKey, this.state);
    } catch {
      this.state.persistFailures += 1;
      this.emit({ type: 'persist-failed', at: this.clock.now() });
    }
  }

  snapshot(): WorkerSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as WorkerSnapshot;
  }

  /**
   * Rehydrate from the store. Anything found mid-flight is treated as a crash
   * casualty and re-queued, because a task that was running when the page died
   * is by definition unfinished. Returns the number of tasks re-queued.
   */
  restore(): number {
    const stored = this.store.read<WorkerSnapshot>(this.snapshotKey);
    if (!stored) return 0;

    const now = this.clock.now();
    let requeued = 0;

    this.state = {
      ...stored,
      version: WORKER_VERSION,
      // Re-anchor uptime to this boot: the counter is per-session, the
      // cumulative `ticks`/`stalls`/`recovers` figures carry over.
      startedAt: now,
      lastHeartbeatAt: now,
      lastTickAt: now,
      tasks: stored.tasks.map((task) => {
        if (task.state !== 'running') return task;
        requeued += 1;
        return {
          ...task,
          state: 'queued' as const,
          updatedAt: now,
          lastError: 're-queued after unexpected shutdown',
        };
      }),
    };

    // Resume id generation past anything already allocated.
    for (const task of this.state.tasks) {
      const numeric = Number.parseInt(task.id.replace(/^\D+/, ''), 10);
      if (Number.isFinite(numeric) && numeric >= this.nextTaskId) {
        this.nextTaskId = numeric + 1;
      }
    }

    this.busy = false;
    this.stalled = false;
    this.bump();
    this.record('info', `restored snapshot seq=${this.state.seq}, re-queued ${requeued}`);
    this.persist();
    this.emit({ type: 'restored', at: now, requeued });
    return requeued;
  }

  // ---------------------------------------------------------------- status

  status(): WorkerStatus {
    const now = this.clock.now();
    let queueDepth = 0;
    let doneCount = 0;
    let failedCount = 0;
    for (const task of this.state.tasks) {
      if (task.state === 'queued' || task.state === 'running') queueDepth += 1;
      else if (task.state === 'done') doneCount += 1;
      else failedCount += 1;
    }
    const lastError = [...this.state.tasks].reverse().find((t) => t.lastError !== null)?.lastError ?? null;

    return {
      running: this.running,
      stalled: this.stalled,
      busy: this.busy,
      uptimeMs: Math.max(0, now - this.state.startedAt),
      ticks: this.state.ticks,
      stalls: this.state.stalls,
      recovers: this.state.recovers,
      persistFailures: this.state.persistFailures,
      queueDepth,
      doneCount,
      failedCount,
      heartbeatAgeMs: Math.max(0, now - this.state.lastHeartbeatAt),
      lastError,
    };
  }

  /** Milliseconds since this boot. */
  uptimeMs(): number {
    return Math.max(0, this.clock.now() - this.state.startedAt);
  }

  /** Cumulative tick count across restores — the "keeps working" odometer. */
  get totalTicks(): number {
    return this.state.ticks;
  }

  get totalStalls(): number {
    return this.state.stalls;
  }

  get totalRecovers(): number {
    return this.state.recovers;
  }
}

/** hh:mm:ss from milliseconds, for the vitals readout. */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
