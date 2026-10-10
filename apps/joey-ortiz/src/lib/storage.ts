/**
 * Snapshot store seam.
 *
 * "Keeps working" means surviving a reload, a tab close, and a crashed tick.
 * The worker never talks to `localStorage` directly; it talks to this
 * interface, and every write is treated as best-effort so a quota error or a
 * blocked storage API can never take the loop down with it.
 */
export interface SnapshotStore {
  read<T>(key: string): T | null;
  write(key: string, value: unknown): void;
  clear(key: string): void;
}

const PREFIX = 'joey-ortiz:v0.0.1:';

export const localStorageStore: SnapshotStore = {
  read<T>(key: string): T | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  },
  write(key: string, value: unknown): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* quota or private-mode failure: the loop keeps running, it just does not persist */
    }
  },
  clear(key: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};

/** In-memory store for tests and for environments with no persistent storage. */
export class MemoryStore implements SnapshotStore {
  private readonly map = new Map<string, unknown>();

  /** When true, `write` throws — used to prove the worker survives storage loss. */
  failing = false;

  read<T>(key: string): T | null {
    const value = this.map.get(key);
    return value === undefined ? null : (value as T);
  }

  write(key: string, value: unknown): void {
    if (this.failing) throw new Error('storage unavailable');
    // Clone so a later mutation of the caller's object cannot corrupt the snapshot.
    this.map.set(key, JSON.parse(JSON.stringify(value) as string));
  }

  clear(key: string): void {
    this.map.delete(key);
  }
}
