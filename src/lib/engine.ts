/** Core review engine: due selection and stage transitions. */

import { DEFAULT_CONFIG, timeoutForStage, type AppConfig } from "./config";
import { resetIfUnanswered } from "./progress";
import {
  ReviewResult,
  hasAnswers,
  recordAnswer,
  validateDeck,
  validatePairConsistency,
  type Deck,
  type DeckItem,
  type PairState,
  type ReviewEvent,
} from "./schemas";
import { burnedStage, NEW_STAGE, nextDueAt, stageAfterFail, stageAfterPass } from "./srs";

/** Trim a typed answer; blank becomes null. */
function cleanAnswer(answer: string | null): string | null {
  const trimmed = answer?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export interface SessionStats {
  total: number;
  passed: number;
  failed: number;
  /** "Something else": recalled an answer that wasn't one of the usual ones. */
  other: number;
  timedOut: number;
  responses: number;
  /** Passes over all reviews, timeouts included. */
  passRate: number;
}

export class ReviewEngine {
  private readonly itemById: Map<string, DeckItem>;
  private readonly pairById: Map<string, PairState>;

  /**
   * `pairs` must match the deck one-to-one (use `syncProgress` first).
   * The engine mutates the pair objects in place.
   */
  constructor(
    readonly deck: Deck,
    readonly pairs: readonly PairState[],
    readonly config: AppConfig = DEFAULT_CONFIG,
  ) {
    validateDeck(deck);
    this.itemById = new Map(deck.items.map((item) => [item.id, item]));
    this.pairById = new Map(pairs.map((pair) => [pair.pairId, pair]));

    for (const pair of pairs) {
      if (!this.itemById.has(pair.pairId)) throw new Error(`Pair ${pair.pairId} not found in deck`);
      validatePairConsistency(pair);
    }
    for (const item of deck.items) {
      if (!this.pairById.has(item.id)) throw new Error(`No progress for deck item ${item.id}; sync progress first`);
    }
  }

  /** Anything not burned can be reviewed, including pairs with no answers yet. */
  isReviewable(pair: PairState): boolean {
    return pair.nextDueAt !== null;
  }

  /** Whether the pair has no accepted answers yet (the user must come up with one). */
  isUnanswered(pairId: string): boolean {
    const item = this.itemById.get(pairId);
    return item !== undefined && !hasAnswers(item);
  }

  getItem(pairId: string): DeckItem | undefined {
    return this.itemById.get(pairId);
  }

  getPairState(pairId: string): PairState | undefined {
    return this.pairById.get(pairId);
  }

  /** Recall time allowed for a pair, based on its current level and the timer settings. */
  timeoutFor(pairId: string): number {
    return timeoutForStage(this.pairById.get(pairId)?.stage ?? NEW_STAGE, this.config.timer);
  }

  /**
   * Call after a pair's answers change. A pair left with no answers goes back
   * to New and becomes due now. Returns whether the pair's state changed.
   */
  syncPair(pairId: string, now: number): boolean {
    const pair = this.pairById.get(pairId);
    const item = this.itemById.get(pairId);
    if (!pair || !item) return false;
    const reset = resetIfUnanswered(pair, item, now);
    if (reset) Object.assign(pair, reset);
    return reset !== null;
  }

  /** Earliest-due pair state among currently due pairs. */
  getDuePairState(now: number): PairState | null {
    let earliest: PairState | null = null;
    for (const pair of this.pairs) {
      const due = pair.nextDueAt;
      if (due === null || due > now) continue;
      if (earliest === null || due < (earliest.nextDueAt as number)) earliest = pair;
    }
    return earliest;
  }

  /** Deck item for the earliest-due pair, or null if none is due. */
  getDuePair(now: number): DeckItem | null {
    const due = this.getDuePairState(now);
    return due ? (this.itemById.get(due.pairId) ?? null) : null;
  }

  dueCount(now: number): number {
    return this.pairs.filter((p) => p.nextDueAt !== null && p.nextDueAt <= now).length;
  }

  /** Milliseconds until the next pair is due, or null if nothing is scheduled. */
  msUntilNextDue(now: number): number | null {
    const times = this.pairs.map((p) => p.nextDueAt).filter((t): t is number => t !== null);
    if (times.length === 0) return null;
    return Math.max(0, Math.min(...times) - now);
  }

  /** Number of pairs at each stage, indexed by stage number (0 = new … last = burned). */
  stageCounts(): number[] {
    const counts = new Array<number>(burnedStage(this.config.srs) + 1).fill(0);
    for (const pair of this.pairs) counts[pair.stage] = (counts[pair.stage] ?? 0) + 1;
    return counts;
  }

  /** Pairs in the deck that have no answers yet (always New). */
  unansweredCount(): number {
    return this.deck.items.filter((item) => !hasAnswers(item)).length;
  }

  /**
   * Recalled one of the pair's answers: up one level. Requires the pair to
   * have an answer; for a pair with none, add the user's answer to the deck
   * first (see SessionController.submitNewAnswer).
   */
  recordPass(pairId: string, elapsedMs: number, userAnswer: string | null, now: number): ReviewEvent {
    const pair = this.getPair(pairId);
    if (this.isUnanswered(pairId)) throw new Error(`Pair ${pairId} needs an answer before it can pass`);
    userAnswer = cleanAnswer(userAnswer);
    pair.responseCount += 1;
    pair.passCount += 1;
    if (userAnswer) recordAnswer(pair, userAnswer);
    return this.moveToStage(pair, stageAfterPass(pair.stage, this.config.srs), {
      result: ReviewResult.PASS,
      elapsedMs,
      userAnswer,
      reason: null,
      now,
    });
  }

  /**
   * "Something else": recalled an answer that isn't one of the usual ones.
   * Between a pass and a fail, so the level stays the same and the pair waits
   * that level's interval again. Add the answer to the deck first.
   */
  recordOther(pairId: string, elapsedMs: number, userAnswer: string, now: number): ReviewEvent {
    const pair = this.getPair(pairId);
    if (this.isUnanswered(pairId)) throw new Error(`Pair ${pairId} has no answers to differ from`);
    const answer = cleanAnswer(userAnswer);
    if (!answer) throw new Error("Answer can't be blank");
    pair.responseCount += 1;
    pair.otherCount += 1;
    recordAnswer(pair, answer);
    return this.moveToStage(pair, pair.stage, {
      result: ReviewResult.OTHER,
      elapsedMs,
      userAnswer: answer,
      reason: null,
      now,
    });
  }

  recordFail(
    pairId: string,
    elapsedMs: number,
    userAnswer: string | null,
    now: number,
    reason: string | null = null,
  ): ReviewEvent {
    const pair = this.getPair(pairId);
    userAnswer = cleanAnswer(userAnswer);
    pair.responseCount += 1;
    pair.failCount += 1;
    if (userAnswer) recordAnswer(pair, userAnswer);
    return this.moveToStage(pair, this.stageAfterMiss(pair), {
      result: ReviewResult.FAIL,
      elapsedMs,
      userAnswer,
      reason,
      now,
    });
  }

  /** A timeout schedules like a fail but doesn't count as a response. */
  recordTimeout(pairId: string, now: number, elapsedMs: number = this.timeoutFor(pairId)): ReviewEvent {
    const pair = this.getPair(pairId);
    pair.timeoutCount += 1;
    return this.moveToStage(pair, this.stageAfterMiss(pair), {
      result: ReviewResult.TIMEOUT,
      elapsedMs,
      userAnswer: null,
      reason: "timeout",
      now,
    });
  }

  static getSessionStats(events: readonly ReviewEvent[]): SessionStats {
    const total = events.length;
    const count = (result: ReviewResult) => events.filter((e) => e.result === result).length;
    const passed = count(ReviewResult.PASS);
    const failed = count(ReviewResult.FAIL);
    const other = count(ReviewResult.OTHER);
    return {
      total,
      passed,
      failed,
      other,
      timedOut: count(ReviewResult.TIMEOUT),
      responses: passed + failed + other,
      passRate: total ? passed / total : 0,
    };
  }

  private getPair(pairId: string): PairState {
    const pair = this.pairById.get(pairId);
    if (!pair) throw new Error(`Unknown pair: ${pairId}`);
    if (pair.nextDueAt === null) throw new Error(`Pair ${pairId} is burned and can't be reviewed`);
    return pair;
  }

  /**
   * Fail/timeout: drop per the SRS rules, except New pairs (and pairs with no
   * answers) stay New and due now, so they come back later in the session.
   */
  private stageAfterMiss(pair: PairState): number {
    if (pair.stage === NEW_STAGE || this.isUnanswered(pair.pairId)) return NEW_STAGE;
    return stageAfterFail(pair.stage, this.config.srs);
  }

  private moveToStage(
    pair: PairState,
    stage: number,
    e: { result: ReviewResult; elapsedMs: number; userAnswer: string | null; reason: string | null; now: number },
  ): ReviewEvent {
    const stageBefore = pair.stage;
    const timeoutMs = this.timeoutFor(pair.pairId);
    pair.stage = stage;
    pair.nextDueAt = nextDueAt(stage, e.now, this.config.srs);
    pair.updatedAt = e.now;
    validatePairConsistency(pair);

    const item = this.itemById.get(pair.pairId);
    if (!item) throw new Error(`Unknown pair in deck: ${pair.pairId}`);

    return {
      pairId: pair.pairId,
      term: item.term,
      result: e.result,
      stageBefore,
      stageAfter: stage,
      elapsedMs: e.elapsedMs,
      timeoutMs,
      reviewedAt: e.now,
      userAnswer: e.userAnswer,
      reason: e.reason,
    };
  }
}
