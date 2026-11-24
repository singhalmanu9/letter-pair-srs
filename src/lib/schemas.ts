/**
 * Data types, parsing/validation of stored data, and small deck helpers.
 * All timestamps are Unix epoch milliseconds.
 */

export const ReviewResult = {
  PASS: "pass",
  FAIL: "fail",
  TIMEOUT: "timeout",
} as const;
export type ReviewResult = (typeof ReviewResult)[keyof typeof ReviewResult];

/** One letter pair and the answers (images/words) the user accepts for it. */
export interface DeckItem {
  id: string;
  term: string;
  answers: string[];
  updatedAt: number;
}

/** A user's own deck. Decks created from a template are independent copies. */
export interface Deck {
  id: string;
  name: string;
  /** Template the deck was created from, if any (informational only). */
  templateId: string | null;
  createdAt: number;
  updatedAt: number;
  items: DeckItem[];
}

/** Scheduling state for one deck item. */
export interface PairState {
  pairId: string;
  /** SRS stage: 0 = new, 1..N = learning stages, N + 1 = burned. */
  stage: number;
  /** When the pair is next due, or null once burned. */
  nextDueAt: number | null;
  /** Non-timeout responses (pass + fail). */
  responseCount: number;
  passCount: number;
  failCount: number;
  timeoutCount: number;
  /** How often the user gave each answer. */
  answerHistory: Record<string, number>;
  updatedAt: number;
}

/** One review outcome. History is an append-only list of these. */
export interface ReviewEvent {
  pairId: string;
  term: string;
  result: ReviewResult;
  stageBefore: number;
  stageAfter: number;
  elapsedMs: number;
  timeoutMs: number;
  reviewedAt: number;
  userAnswer: string | null;
  reason: string | null;
}

/** The review in progress, saved so a reload can resume it. */
export interface ActiveReviewSnapshot {
  deckId: string;
  pairId: string;
  startedAt: number;
  revealed: boolean;
}

// ---------------------------------------------------------------------------
// Parsing. Each parser accepts unknown JSON and either returns a well-typed
// value or throws a ValidationError naming the offending field.

export class ValidationError extends Error {
  override name = "ValidationError";
}

type Json = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Json;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function string(value: unknown, path: string, { nonEmpty = false } = {}): string {
  if (typeof value !== "string") fail(path, "expected a string");
  if (nonEmpty && value.trim() === "") fail(path, "must not be empty");
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
  return value;
}

function count(value: unknown, path: string): number {
  const n = number(value, path);
  if (!Number.isInteger(n) || n < 0) fail(path, "expected a non-negative integer");
  return n;
}

function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === null || value === undefined ? null : parse(value);
}

export function parseDeckItem(value: unknown, path = "item"): DeckItem {
  const o = record(value, path);
  const answers = array(o.answers, `${path}.answers`).map((a, i) =>
    string(a, `${path}.answers[${i}]`, { nonEmpty: true }),
  );
  if (answers.length === 0) fail(`${path}.answers`, "must contain at least one answer");
  return {
    id: string(o.id, `${path}.id`, { nonEmpty: true }),
    term: string(o.term, `${path}.term`, { nonEmpty: true }),
    answers,
    updatedAt: number(o.updatedAt, `${path}.updatedAt`),
  };
}

export function parseDeck(value: unknown, path = "deck"): Deck {
  const o = record(value, path);
  const items = array(o.items, `${path}.items`).map((item, i) => parseDeckItem(item, `${path}.items[${i}]`));
  const deck: Deck = {
    id: string(o.id, `${path}.id`, { nonEmpty: true }),
    name: string(o.name, `${path}.name`, { nonEmpty: true }),
    templateId: nullable(o.templateId, (v) => string(v, `${path}.templateId`)),
    createdAt: number(o.createdAt, `${path}.createdAt`),
    updatedAt: number(o.updatedAt, `${path}.updatedAt`),
    items,
  };
  validateDeck(deck);
  return deck;
}

export function parsePairState(value: unknown, path = "pair"): PairState {
  const o = record(value, path);
  const historyObj = record(o.answerHistory ?? {}, `${path}.answerHistory`);
  const answerHistory: Record<string, number> = {};
  for (const [answer, n] of Object.entries(historyObj)) {
    answerHistory[answer] = count(n, `${path}.answerHistory[${JSON.stringify(answer)}]`);
  }
  const pair: PairState = {
    pairId: string(o.pairId, `${path}.pairId`, { nonEmpty: true }),
    stage: count(o.stage, `${path}.stage`),
    nextDueAt: nullable(o.nextDueAt, (v) => number(v, `${path}.nextDueAt`)),
    responseCount: count(o.responseCount, `${path}.responseCount`),
    passCount: count(o.passCount, `${path}.passCount`),
    failCount: count(o.failCount, `${path}.failCount`),
    timeoutCount: count(o.timeoutCount, `${path}.timeoutCount`),
    answerHistory,
    updatedAt: number(o.updatedAt, `${path}.updatedAt`),
  };
  validatePairConsistency(pair);
  return pair;
}

export function parseProgress(value: unknown, path = "progress"): PairState[] {
  return array(value, path).map((p, i) => parsePairState(p, `${path}[${i}]`));
}

export function parseReviewEvent(value: unknown, path = "event"): ReviewEvent {
  const o = record(value, path);
  const result = o.result;
  if (!Object.values(ReviewResult).includes(result as ReviewResult)) {
    fail(`${path}.result`, `invalid review result ${JSON.stringify(result)}`);
  }
  return {
    pairId: string(o.pairId, `${path}.pairId`, { nonEmpty: true }),
    term: string(o.term, `${path}.term`),
    result: result as ReviewResult,
    stageBefore: count(o.stageBefore, `${path}.stageBefore`),
    stageAfter: count(o.stageAfter, `${path}.stageAfter`),
    elapsedMs: number(o.elapsedMs, `${path}.elapsedMs`),
    timeoutMs: number(o.timeoutMs, `${path}.timeoutMs`),
    reviewedAt: number(o.reviewedAt, `${path}.reviewedAt`),
    userAnswer: nullable(o.userAnswer, (v) => string(v, `${path}.userAnswer`)),
    reason: nullable(o.reason, (v) => string(v, `${path}.reason`)),
  };
}

export function parseHistory(value: unknown, path = "history"): ReviewEvent[] {
  return array(value, path).map((e, i) => parseReviewEvent(e, `${path}[${i}]`));
}

export function parseActiveReviewSnapshot(value: unknown, path = "activeReview"): ActiveReviewSnapshot {
  const o = record(value, path);
  if (typeof o.revealed !== "boolean") fail(`${path}.revealed`, "expected a boolean");
  return {
    deckId: string(o.deckId, `${path}.deckId`, { nonEmpty: true }),
    pairId: string(o.pairId, `${path}.pairId`, { nonEmpty: true }),
    startedAt: number(o.startedAt, `${path}.startedAt`),
    revealed: o.revealed,
  };
}

// ---------------------------------------------------------------------------
// Validation

/** Throws if the deck has duplicate ids or duplicate terms. An empty deck is valid. */
export function validateDeck(deck: Deck): true {
  const ids = new Set<string>();
  const terms = new Set<string>();
  for (const item of deck.items) {
    if (ids.has(item.id)) throw new ValidationError(`Duplicate item id in deck: ${item.id}`);
    const term = item.term.trim().toUpperCase();
    if (terms.has(term)) throw new ValidationError(`Duplicate term in deck: ${item.term}`);
    ids.add(item.id);
    terms.add(term);
  }
  return true;
}

/** Throws if the pair's counters are inconsistent. */
export function validatePairConsistency(pair: PairState): true {
  if (pair.responseCount !== pair.passCount + pair.failCount) {
    throw new ValidationError(
      `Consistency error for pair ${pair.pairId}: responseCount must equal passCount + failCount`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deck helpers

export function getItemById(deck: Deck, pairId: string): DeckItem | undefined {
  return deck.items.find((item) => item.id === pairId);
}

/**
 * Add an accepted answer to a pair. Returns false if the answer is blank,
 * already present, or the pair doesn't exist.
 */
export function addAnswerToPair(deck: Deck, pairId: string, answer: string, now: number): boolean {
  const item = getItemById(deck, pairId);
  const trimmed = answer.trim();
  if (!item || trimmed === "" || item.answers.includes(trimmed)) return false;
  item.answers.push(trimmed);
  item.updatedAt = now;
  deck.updatedAt = now;
  return true;
}

// ---------------------------------------------------------------------------
// Pair state helpers

export function recordAnswer(pair: PairState, answer: string): void {
  pair.answerHistory[answer] = (pair.answerHistory[answer] ?? 0) + 1;
}

export function mostCommonAnswer(pair: PairState): string | null {
  let best: string | null = null;
  let bestCount = -Infinity;
  for (const [answer, n] of Object.entries(pair.answerHistory)) {
    if (n > bestCount) {
      best = answer;
      bestCount = n;
    }
  }
  return best;
}

export function totalResponses(pair: PairState): number {
  return pair.responseCount + pair.timeoutCount;
}
