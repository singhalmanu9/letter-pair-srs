/** Creating pair state and keeping it in step with the deck. */

import { NEW_STAGE } from "./srs";
import { hasAnswers, type Deck, type DeckItem, type PairState } from "./schemas";

/** Fresh state for a pair the user hasn't reviewed yet: new and due now. */
export function newPairState(pairId: string, now: number): PairState {
  return {
    pairId,
    stage: NEW_STAGE,
    nextDueAt: now,
    responseCount: 0,
    passCount: 0,
    failCount: 0,
    otherCount: 0,
    timeoutCount: 0,
    answerHistory: {},
    updatedAt: now,
  };
}

/**
 * Pairs with no answers are always New and due. Returns the corrected state
 * if `pair` breaks that rule (counters are kept), otherwise null.
 */
export function resetIfUnanswered(pair: PairState, item: DeckItem, now: number): PairState | null {
  if (hasAnswers(item)) return null;
  if (pair.stage === NEW_STAGE && pair.nextDueAt !== null && pair.nextDueAt <= now) return null;
  return { ...pair, stage: NEW_STAGE, nextDueAt: now, updatedAt: now };
}

export interface SyncResult {
  pairs: PairState[];
  /** Pair ids that were in the deck but had no progress. */
  added: string[];
  /** Pair ids whose progress was dropped because the deck item is gone. */
  removed: string[];
  /** Pair ids sent back to New because they have no answers. */
  reset: string[];
}

/**
 * Return progress matching the deck: new pairs get fresh state, progress for
 * removed pairs is dropped, pairs with no answers are reset to New, and order
 * follows the deck. Does not mutate input.
 */
export function syncProgress(deck: Deck, pairs: readonly PairState[], now: number): SyncResult {
  const byId = new Map(pairs.map((p) => [p.pairId, p]));
  const deckIds = new Set(deck.items.map((item) => item.id));

  const added: string[] = [];
  const reset: string[] = [];
  const synced = deck.items.map((item) => {
    const existing = byId.get(item.id);
    if (!existing) {
      added.push(item.id);
      return newPairState(item.id, now);
    }
    const corrected = resetIfUnanswered(existing, item, now);
    if (!corrected) return existing;
    reset.push(item.id);
    return corrected;
  });
  const removed = pairs.filter((p) => !deckIds.has(p.pairId)).map((p) => p.pairId);

  return { pairs: synced, added, removed, reset };
}
