import { DEFAULT_CONFIG } from "../src/lib/config";
import { newPairState } from "../src/lib/progress";
import type { Deck, PairState } from "../src/lib/schemas";

export const config = DEFAULT_CONFIG;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Build a deck from [id, term, answers?] tuples. */
export function makeDeck(items: [string, string, string[]?][], id = "deck1"): Deck {
  return {
    id,
    name: "Test deck",
    templateId: null,
    createdAt: 0,
    updatedAt: 0,
    items: items.map(([itemId, term, answers]) => ({ id: itemId, term, answers: answers ?? ["x"], updatedAt: 0 })),
  };
}

export function makePair(pairId: string, overrides: Partial<PairState> = {}): PairState {
  return { ...newPairState(pairId, 0), ...overrides };
}
