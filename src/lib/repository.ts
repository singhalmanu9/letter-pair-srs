/**
 * Typed, versioned persistence on top of an AsyncKeyValueStore.
 *
 * Layout (one key each):
 *   lpsrs:meta                 { schemaVersion, activeDeckId }
 *   lpsrs:decks                [deckId, ...]
 *   lpsrs:deck:<id>            Deck
 *   lpsrs:progress:<id>        PairState[]
 *   lpsrs:history:<id>         ReviewEvent[] (append-only)
 *   lpsrs:activeReview         ActiveReviewSnapshot
 *
 * Corrupt or invalid data is never silently overwritten: reads throw a
 * CorruptDataError naming the key, and the app decides what to do.
 */

import {
  parseActiveReviewSnapshot,
  parseDeck,
  parseHistory,
  parseProgress,
  type ActiveReviewSnapshot,
  type Deck,
  type PairState,
  type ReviewEvent,
} from "./schemas";
import type { AsyncKeyValueStore } from "./storage";

export const SCHEMA_VERSION = 1;
const PREFIX = "lpsrs:";

export const KEYS = {
  meta: `${PREFIX}meta`,
  deckIndex: `${PREFIX}decks`,
  deck: (id: string) => `${PREFIX}deck:${id}`,
  progress: (id: string) => `${PREFIX}progress:${id}`,
  history: (id: string) => `${PREFIX}history:${id}`,
  activeReview: `${PREFIX}activeReview`,
} as const;

export interface Meta {
  schemaVersion: number;
  activeDeckId: string | null;
}

export class CorruptDataError extends Error {
  override name = "CorruptDataError";
  constructor(
    readonly key: string,
    override readonly cause: unknown,
  ) {
    super(`Stored data at "${key}" is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export class NewerSchemaError extends Error {
  override name = "NewerSchemaError";
  constructor(readonly storedVersion: number) {
    super(`Stored data uses schema v${storedVersion}, but this app only understands up to v${SCHEMA_VERSION}`);
  }
}

/**
 * Migrations keyed by the version they upgrade *from*. Each must leave the
 * store valid for version + 1. Empty until the format first changes.
 */
type Migration = (store: AsyncKeyValueStore) => Promise<void>;
const MIGRATIONS: Record<number, Migration> = {};

export class Repository {
  constructor(private readonly store: AsyncKeyValueStore) {}

  /** Create metadata on first run and apply any pending migrations. */
  async init(): Promise<Meta> {
    const meta = await this.readParsed(KEYS.meta, parseMeta);
    if (meta === null) {
      const fresh: Meta = { schemaVersion: SCHEMA_VERSION, activeDeckId: null };
      await this.write(KEYS.meta, fresh);
      return fresh;
    }
    if (meta.schemaVersion > SCHEMA_VERSION) throw new NewerSchemaError(meta.schemaVersion);

    for (let v = meta.schemaVersion; v < SCHEMA_VERSION; v++) {
      const migrate = MIGRATIONS[v];
      if (!migrate) throw new Error(`No migration from schema v${v}`);
      await migrate(this.store);
      meta.schemaVersion = v + 1;
      await this.write(KEYS.meta, meta);
    }
    return meta;
  }

  async getMeta(): Promise<Meta> {
    const meta = await this.readParsed(KEYS.meta, parseMeta);
    if (meta === null) throw new Error("Repository not initialized; call init() first");
    return meta;
  }

  async setActiveDeck(deckId: string | null): Promise<void> {
    const meta = await this.getMeta();
    await this.write(KEYS.meta, { ...meta, activeDeckId: deckId });
  }

  // --- Decks -----------------------------------------------------------------

  async listDeckIds(): Promise<string[]> {
    return (await this.readParsed(KEYS.deckIndex, parseIdList)) ?? [];
  }

  async getDeck(deckId: string): Promise<Deck | null> {
    return this.readParsed(KEYS.deck(deckId), parseDeck);
  }

  async listDecks(): Promise<Deck[]> {
    const decks: Deck[] = [];
    for (const id of await this.listDeckIds()) {
      const deck = await this.getDeck(id);
      if (deck) decks.push(deck);
    }
    return decks;
  }

  async saveDeck(deck: Deck): Promise<void> {
    parseDeck(deck); // validate before writing
    await this.write(KEYS.deck(deck.id), deck);
    const ids = await this.listDeckIds();
    if (!ids.includes(deck.id)) await this.write(KEYS.deckIndex, [...ids, deck.id]);
  }

  /** Delete a deck with its progress and history. */
  async deleteDeck(deckId: string): Promise<void> {
    const ids = await this.listDeckIds();
    await this.write(
      KEYS.deckIndex,
      ids.filter((id) => id !== deckId),
    );
    await this.store.remove(KEYS.deck(deckId));
    await this.store.remove(KEYS.progress(deckId));
    await this.store.remove(KEYS.history(deckId));

    const meta = await this.getMeta();
    if (meta.activeDeckId === deckId) await this.setActiveDeck(null);
    const active = await this.getActiveReview();
    if (active?.deckId === deckId) await this.clearActiveReview();
  }

  // --- Progress & history ----------------------------------------------------

  async getProgress(deckId: string): Promise<PairState[] | null> {
    return this.readParsed(KEYS.progress(deckId), parseProgress);
  }

  async saveProgress(deckId: string, pairs: readonly PairState[]): Promise<void> {
    await this.write(KEYS.progress(deckId), pairs);
  }

  async getHistory(deckId: string): Promise<ReviewEvent[]> {
    return (await this.readParsed(KEYS.history(deckId), parseHistory)) ?? [];
  }

  async appendEvent(deckId: string, event: ReviewEvent): Promise<void> {
    const history = await this.getHistory(deckId);
    history.push(event);
    await this.write(KEYS.history(deckId), history);
  }

  // --- Active review -----------------------------------------------------------

  async getActiveReview(): Promise<ActiveReviewSnapshot | null> {
    return this.readParsed(KEYS.activeReview, parseActiveReviewSnapshot);
  }

  async saveActiveReview(snapshot: ActiveReviewSnapshot): Promise<void> {
    await this.write(KEYS.activeReview, snapshot);
  }

  async clearActiveReview(): Promise<void> {
    await this.store.remove(KEYS.activeReview);
  }

  // --- Maintenance -----------------------------------------------------------

  /** Remove everything this app has stored. */
  async resetAll(): Promise<void> {
    for (const key of await this.store.keys(PREFIX)) await this.store.remove(key);
  }

  private async readParsed<T>(key: string, parse: (value: unknown) => T): Promise<T | null> {
    const raw = await this.store.get(key);
    if (raw === null) return null;
    try {
      return parse(JSON.parse(raw));
    } catch (error) {
      throw new CorruptDataError(key, error);
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    await this.store.set(key, JSON.stringify(value));
  }
}

function parseMeta(value: unknown): Meta {
  if (typeof value !== "object" || value === null) throw new Error("meta must be an object");
  const o = value as Record<string, unknown>;
  if (typeof o.schemaVersion !== "number" || !Number.isInteger(o.schemaVersion) || o.schemaVersion < 1) {
    throw new Error("meta.schemaVersion must be a positive integer");
  }
  if (o.activeDeckId !== null && typeof o.activeDeckId !== "string") {
    throw new Error("meta.activeDeckId must be a string or null");
  }
  return { schemaVersion: o.schemaVersion, activeDeckId: o.activeDeckId };
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error("deck index must be an array of strings");
  }
  return value;
}
