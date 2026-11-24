/**
 * App startup: load the active deck and its progress from storage, bring
 * progress in step with the deck, and wire the session to persistence.
 */

import type { AppConfig } from "../lib/config";
import { ReviewEngine } from "../lib/engine";
import { syncProgress } from "../lib/progress";
import { CorruptDataError, Repository } from "../lib/repository";
import type { Deck } from "../lib/schemas";
import { SessionController } from "../lib/session";
import { createDeckFromTemplate, type DeckTemplate } from "../lib/templates";

/**
 * Runs async writes one at a time, in order, so a slow save can't be
 * overtaken by a later one. Failures go to `onError` and don't block
 * later writes.
 */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(write: () => Promise<void>): void {
    this.tail = this.tail.then(write).catch(this.onError);
  }

  /** Resolves once every queued write has finished. */
  idle(): Promise<void> {
    return this.tail;
  }
}

export interface AppContext {
  repo: Repository;
  deck: Deck;
  engine: ReviewEngine;
  session: SessionController;
  writes: WriteQueue;
}

export type LoadResult =
  | { kind: "ready"; app: AppContext }
  /** No decks yet: the user needs to pick a template. */
  | { kind: "no-deck" }
  /** Stored data couldn't be read. `key` is set for corrupt data. */
  | { kind: "error"; error: unknown; key: string | null };

export interface LoadOptions {
  now: number;
  onPersistError: (error: unknown) => void;
}

export async function loadApp(repo: Repository, config: AppConfig, opts: LoadOptions): Promise<LoadResult> {
  try {
    const meta = await repo.init();
    const deckIds = await repo.listDeckIds();
    if (deckIds.length === 0) return { kind: "no-deck" };

    const deckId = meta.activeDeckId && deckIds.includes(meta.activeDeckId) ? meta.activeDeckId : deckIds[0]!;
    const deck = await repo.getDeck(deckId);
    if (!deck) throw new CorruptDataError(`deck:${deckId}`, new Error("deck is listed but missing"));
    if (meta.activeDeckId !== deckId) await repo.setActiveDeck(deckId);

    const stored = await repo.getProgress(deckId);
    const { pairs, added, removed, reset } = syncProgress(deck, stored ?? [], opts.now);
    if (stored === null || added.length || removed.length || reset.length) await repo.saveProgress(deckId, pairs);

    const engine = new ReviewEngine(deck, pairs, config);
    const writes = new WriteQueue(opts.onPersistError);
    const session = new SessionController(engine, {
      saveDeck: (d) => writes.enqueue(() => repo.saveDeck(d)),
      saveProgress: (p) => writes.enqueue(() => repo.saveProgress(deckId, p)),
      appendEvent: (e) => writes.enqueue(() => repo.appendEvent(deckId, e)),
      saveActiveReview: (s) => writes.enqueue(() => repo.saveActiveReview(s)),
      clearActiveReview: () => writes.enqueue(() => repo.clearActiveReview()),
    });

    const snapshot = await repo.getActiveReview();
    if (snapshot && !session.restoreActiveReview(snapshot, opts.now)) await repo.clearActiveReview();

    return { kind: "ready", app: { repo, deck, engine, session, writes } };
  } catch (error) {
    return { kind: "error", error, key: error instanceof CorruptDataError ? error.key : null };
  }
}

/** Create a deck from a template, save it and make it the active deck. */
export async function createDeck(repo: Repository, template: DeckTemplate, now: number): Promise<Deck> {
  await repo.init();
  const deck = createDeckFromTemplate(template, now);
  await repo.saveDeck(deck);
  await repo.setActiveDeck(deck.id);
  return deck;
}
