/**
 * Data structures and validation. Field names are snake_case so the JSON
 * format stays compatible with files written by the original Python app.
 */

export const ReviewResult = {
  PASS: "pass",
  FAIL: "fail",
  TIMEOUT: "timeout",
} as const;
export type ReviewResult = (typeof ReviewResult)[keyof typeof ReviewResult];

/** A single term with multiple accepted answers. */
export interface DeckItem {
  id: string;
  term: string;
  answers: string[];
}

/** Mutable scheduling state for one deck item. */
export interface PairState {
  pair_id: string;
  /** Unix timestamp (seconds) when the pair is next due. */
  next_due: number;
  /** Current interval in seconds. */
  current_interval: number;
  /** Non-timeout responses (pass + fail). */
  response_count: number;
  pass_count: number;
  fail_count: number;
  timeout_count: number;
  /** How often the user gave each answer. */
  answer_history: Record<string, number>;
}

/** A single review outcome. */
export interface ReviewEvent {
  pair_id: string;
  term: string;
  result: ReviewResult;
  elapsed_seconds: number;
  /** ISO 8601 UTC datetime. */
  timestamp: string;
  timeout_seconds: number;
  user_answer: string | null;
  reason: string | null;
}

export interface Deck {
  version: string;
  items: DeckItem[];
}

export interface SRSState {
  version: string;
  pairs: PairState[];
}

// ---------------------------------------------------------------------------
// Construction / parsing

export function makePairState(
  init: Pick<PairState, "pair_id" | "next_due" | "current_interval"> & Partial<PairState>,
): PairState {
  return {
    response_count: 0,
    pass_count: 0,
    fail_count: 0,
    timeout_count: 0,
    ...init,
    answer_history: { ...(init.answer_history ?? {}) },
  };
}

export function makeReviewEvent(
  init: Omit<ReviewEvent, "user_answer" | "reason"> & Partial<Pick<ReviewEvent, "user_answer" | "reason">>,
): ReviewEvent {
  return { user_answer: null, reason: null, ...init };
}

/** Parse a pair state from JSON, accepting the legacy `attempt_count` field. */
export function pairStateFromJSON(data: Record<string, unknown>): PairState {
  const copy: Record<string, unknown> = { ...data };
  if (!("response_count" in copy) && "attempt_count" in copy) {
    copy.response_count = copy.attempt_count;
    delete copy.attempt_count;
  }
  return makePairState(copy as unknown as PairState);
}

export function deckFromJSON(data: { version?: string; items?: DeckItem[] }): Deck {
  return {
    version: data.version ?? "1.0",
    items: (data.items ?? []).map((item) => ({ ...item, answers: [...item.answers] })),
  };
}

export function stateFromJSON(data: { version?: string; pairs?: Record<string, unknown>[] }): SRSState {
  return {
    version: data.version ?? "1.0",
    pairs: (data.pairs ?? []).map(pairStateFromJSON),
  };
}

export function reviewEventFromJSON(data: Record<string, unknown>): ReviewEvent {
  const result = data.result;
  if (!Object.values(ReviewResult).includes(result as ReviewResult)) {
    throw new Error(`Invalid review result: ${String(result)}`);
  }
  return makeReviewEvent(data as unknown as ReviewEvent);
}

// ---------------------------------------------------------------------------
// Deck helpers

/** Add an accepted answer. Returns false if it was already present. */
export function addAnswer(item: DeckItem, answer: string): boolean {
  if (item.answers.includes(answer)) return false;
  item.answers.push(answer);
  return true;
}

export function getItemById(deck: Deck, pairId: string): DeckItem | undefined {
  return deck.items.find((item) => item.id === pairId);
}

/** Add an answer to a pair. Returns false if already present or pair not found. */
export function addAnswerToPair(deck: Deck, pairId: string, answer: string): boolean {
  const item = getItemById(deck, pairId);
  return item ? addAnswer(item, answer) : false;
}

// ---------------------------------------------------------------------------
// Pair state helpers

export function recordAnswer(pair: PairState, answer: string): void {
  pair.answer_history[answer] = (pair.answer_history[answer] ?? 0) + 1;
}

export function mostCommonAnswer(pair: PairState): string | null {
  let best: string | null = null;
  let bestCount = -Infinity;
  for (const [answer, count] of Object.entries(pair.answer_history)) {
    if (count > bestCount) {
      best = answer;
      bestCount = count;
    }
  }
  return best;
}

export function totalResponses(pair: PairState): number {
  return pair.response_count + pair.timeout_count;
}

/** Throws if the pair's counters are inconsistent. */
export function validatePairConsistency(pair: PairState): true {
  const { response_count, pass_count, fail_count, timeout_count } = pair;
  if (Math.min(response_count, pass_count, fail_count, timeout_count) < 0) {
    throw new Error(`Negative counters are not allowed for pair ${pair.pair_id}`);
  }
  if (response_count !== pass_count + fail_count) {
    throw new Error(
      `Consistency error for pair ${pair.pair_id}: response_count must equal pass_count + fail_count`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation

export function validateDeck(deck: Deck): true {
  if (deck.items.length === 0) throw new Error("Deck must contain at least one item");
  for (const item of deck.items) {
    if (!item.id || !item.term || !Array.isArray(item.answers) || item.answers.length === 0) {
      throw new Error(`Invalid deck item: ${JSON.stringify(item)}`);
    }
  }
  return true;
}

/** Validate that every pair references a deck item and is internally consistent. */
export function validateState(deck: Deck, state: SRSState): true {
  const deckIds = new Set(deck.items.map((item) => item.id));
  for (const pair of state.pairs) {
    if (!deckIds.has(pair.pair_id)) throw new Error(`Pair ${pair.pair_id} not found in deck`);
    validatePairConsistency(pair);
  }
  return true;
}
