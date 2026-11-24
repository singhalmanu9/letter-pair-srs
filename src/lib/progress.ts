/** Creating pair state and keeping it in step with the deck. */

import { NEW_STAGE } from "./srs";
import type { Deck, PairState } from "./schemas";

/** Fresh state for a pair the user hasn't reviewed yet: new and due now. */
export function newPairState(pairId: string, now: number): PairState {
  return {
    pairId,
    stage: NEW_STAGE,
    nextDueAt: now,
    responseCount: 0,
    passCount: 0,
    failCount: 0,
    timeoutCount: 0,
    answerHistory: {},
    updatedAt: now,
  };
}

export interface SyncResult {
  pairs: PairState[];
  /** Pair ids that were in the deck but had no progress. */
  added: string[];
  /** Pair ids whose progress was dropped because the deck item is gone. */
  removed: string[];
}

/**
 * Return progress matching the deck: new pairs get fresh state, progress for
 * removed pairs is dropped, and order follows the deck. Does not mutate input.
 */
export function syncProgress(deck: Deck, pairs: readonly PairState[], now: number): SyncResult {
  const byId = new Map(pairs.map((p) => [p.pairId, p]));
  const deckIds = new Set(deck.items.map((item) => item.id));

  const added: string[] = [];
  const synced = deck.items.map((item) => {
    const existing = byId.get(item.id);
    if (existing) return existing;
    added.push(item.id);
    return newPairState(item.id, now);
  });
  const removed = pairs.filter((p) => !deckIds.has(p.pairId)).map((p) => p.pairId);

  return { pairs: synced, added, removed };
}
