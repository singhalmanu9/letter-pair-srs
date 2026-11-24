/**
 * Persistence for deck, state, history and the in-progress review.
 *
 * Everything goes through a minimal key-value store so the browser can use
 * `localStorage` while tests use an in-memory store.
 */

import { nowSeconds } from "./config";
import {
  deckFromJSON,
  makePairState,
  reviewEventFromJSON,
  stateFromJSON,
  validateDeck,
  validateState,
  type Deck,
  type ReviewEvent,
  type SRSState,
} from "./schemas";
import type { ActiveReviewSnapshot } from "./session";

/** The subset of the Web Storage API we rely on. `localStorage` satisfies it. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_KEYS = {
  deck: "lpsrs.deck",
  state: "lpsrs.state",
  history: "lpsrs.history",
  session: "lpsrs.session",
} as const;

/** In-memory store, for tests and as a fallback when localStorage is unavailable. */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function readJSON<T>(store: KeyValueStore, key: string): T | null {
  const raw = store.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

function writeJSON(store: KeyValueStore, key: string, value: unknown): void {
  store.setItem(key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Deck

/** Load the deck, or save and return `fallback` if none is stored yet. */
export function loadDeck(store: KeyValueStore, fallback?: Deck): Deck {
  const data = readJSON<Parameters<typeof deckFromJSON>[0]>(store, STORAGE_KEYS.deck);
  if (data === null) {
    if (!fallback) throw new Error("No deck stored and no fallback deck provided");
    const deck = deckFromJSON(fallback);
    saveDeck(store, deck);
    return deck;
  }
  const deck = deckFromJSON(data);
  validateDeck(deck);
  return deck;
}

export function saveDeck(store: KeyValueStore, deck: Deck): void {
  validateDeck(deck);
  writeJSON(store, STORAGE_KEYS.deck, deck);
}

// ---------------------------------------------------------------------------
// State

/** Load scheduling state, initializing it for the deck if none is stored. */
export function loadState(store: KeyValueStore, deck: Deck): SRSState {
  const data = readJSON<Parameters<typeof stateFromJSON>[0]>(store, STORAGE_KEYS.state);
  if (data === null) {
    const state = initializeStateForDeck(deck);
    saveState(store, state);
    return state;
  }
  const state = stateFromJSON(data);
  validateState(deck, state);
  return state;
}

export function saveState(store: KeyValueStore, state: SRSState): void {
  writeJSON(store, STORAGE_KEYS.state, state);
}

/** Fresh state with every deck item due immediately. */
export function initializeStateForDeck(deck: Deck, initialInterval = 60): SRSState {
  const now = nowSeconds();
  return {
    version: "1.0",
    pairs: deck.items.map((item) =>
      makePairState({ pair_id: item.id, next_due: now, current_interval: initialInterval }),
    ),
  };
}

// ---------------------------------------------------------------------------
// History

export function appendReviewEvent(store: KeyValueStore, event: ReviewEvent): void {
  const history = readJSON<unknown[]>(store, STORAGE_KEYS.history) ?? [];
  history.push(event);
  writeJSON(store, STORAGE_KEYS.history, history);
}

export function loadHistory(store: KeyValueStore): ReviewEvent[] {
  const history = readJSON<Record<string, unknown>[]>(store, STORAGE_KEYS.history) ?? [];
  return history.map(reviewEventFromJSON);
}

// ---------------------------------------------------------------------------
// Active review snapshot

export function loadSessionSnapshot(store: KeyValueStore): ActiveReviewSnapshot | null {
  const data = readJSON<unknown>(store, STORAGE_KEYS.session);
  if (data === null) return null;
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Session snapshot must be a JSON object");
  }
  return data as ActiveReviewSnapshot;
}

export function saveSessionSnapshot(store: KeyValueStore, snapshot: ActiveReviewSnapshot): void {
  writeJSON(store, STORAGE_KEYS.session, snapshot);
}

export function clearSessionSnapshot(store: KeyValueStore): void {
  store.removeItem(STORAGE_KEYS.session);
}
