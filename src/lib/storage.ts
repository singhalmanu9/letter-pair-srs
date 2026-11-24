/**
 * Low-level async key-value storage. Async even though localStorage isn't,
 * so a network-backed store can be dropped in later without touching callers.
 */

export interface AsyncKeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** All keys that start with `prefix`. */
  keys(prefix: string): Promise<string[]>;
}

/** In-memory store, for tests and as a fallback when localStorage is unavailable. */
export class MemoryStore implements AsyncKeyValueStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** Adapter for the Web Storage API (`localStorage`). */
export class WebStorageStore implements AsyncKeyValueStore {
  constructor(private readonly storage: Storage) {}

  async get(key: string): Promise<string | null> {
    return this.storage.getItem(key);
  }
  async set(key: string, value: string): Promise<void> {
    // Throws a QuotaExceededError DOMException when storage is full.
    this.storage.setItem(key, value);
  }
  async remove(key: string): Promise<void> {
    this.storage.removeItem(key);
  }
  async keys(prefix: string): Promise<string[]> {
    const result: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key !== null && key.startsWith(prefix)) result.push(key);
    }
    return result;
  }
}

export interface BrowserStore {
  store: AsyncKeyValueStore;
  /** False when localStorage was unavailable and data will be lost on reload. */
  durable: boolean;
}

/** localStorage if it works, otherwise an in-memory fallback. */
export function getBrowserStore(): BrowserStore {
  try {
    const probe = "lpsrs:probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return { store: new WebStorageStore(window.localStorage), durable: true };
  } catch {
    return { store: new MemoryStore(), durable: false };
  }
}

/**
 * Ask the browser not to evict our storage under disk pressure. Best-effort:
 * returns whether storage is (now) persistent, or false if unsupported.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
