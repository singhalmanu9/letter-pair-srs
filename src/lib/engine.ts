/** Core review engine: due selection and scheduling transitions. */

import { DEFAULT_CONFIG, nowSeconds, type SRSConfig } from "./config";
import {
  ReviewResult,
  recordAnswer,
  validatePairConsistency,
  validateState,
  type Deck,
  type DeckItem,
  type PairState,
  type ReviewEvent,
  type SRSState,
} from "./schemas";

export interface SessionStats {
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  responses: number;
  passRate: number;
}

export class ReviewEngine {
  private readonly itemById: Map<string, DeckItem>;
  private readonly pairById: Map<string, PairState>;

  constructor(
    readonly deck: Deck,
    readonly state: SRSState,
    readonly config: SRSConfig = DEFAULT_CONFIG,
  ) {
    validateState(deck, state);
    this.itemById = new Map(deck.items.map((item) => [item.id, item]));
    this.pairById = new Map(state.pairs.map((pair) => [pair.pair_id, pair]));
  }

  /** Earliest-due pair state among currently due pairs. */
  getDuePairState(now: number = nowSeconds()): PairState | null {
    let earliest: PairState | null = null;
    for (const pair of this.state.pairs) {
      if (pair.next_due <= now && (earliest === null || pair.next_due < earliest.next_due)) {
        earliest = pair;
      }
    }
    return earliest;
  }

  /** Deck item for the earliest-due pair, or null if none is due. */
  getDuePair(now: number = nowSeconds()): DeckItem | null {
    const due = this.getDuePairState(now);
    return due ? (this.itemById.get(due.pair_id) ?? null) : null;
  }

  /** Seconds until the next pair is due, or null if there are no pairs. */
  secondsUntilNextDue(now: number = nowSeconds()): number | null {
    if (this.state.pairs.length === 0) return null;
    const nextDue = Math.min(...this.state.pairs.map((pair) => pair.next_due));
    return Math.max(0, nextDue - now);
  }

  recordPass(
    pairId: string,
    elapsedSeconds: number,
    userAnswer: string | null = null,
    now: number = nowSeconds(),
  ): ReviewEvent {
    const pair = this.getPair(pairId);
    pair.response_count += 1;
    pair.pass_count += 1;
    if (userAnswer) recordAnswer(pair, userAnswer);

    const grown = Math.round(pair.current_interval * this.config.passIntervalMultiplier);
    pair.current_interval = Math.max(1, grown);
    pair.next_due = now + pair.current_interval;
    validatePairConsistency(pair);

    return this.buildEvent(pairId, ReviewResult.PASS, elapsedSeconds, now, userAnswer, null);
  }

  recordFail(
    pairId: string,
    elapsedSeconds: number,
    userAnswer: string | null = null,
    now: number = nowSeconds(),
    reason: string | null = null,
  ): ReviewEvent {
    const pair = this.getPair(pairId);
    pair.response_count += 1;
    pair.fail_count += 1;
    if (userAnswer) recordAnswer(pair, userAnswer);

    pair.current_interval = this.config.failIntervalReset;
    pair.next_due = now + pair.current_interval;
    validatePairConsistency(pair);

    return this.buildEvent(pairId, ReviewResult.FAIL, elapsedSeconds, now, userAnswer, reason);
  }

  /** Timeout has the same scheduling effect as a fail, but isn't a response. */
  recordTimeout(pairId: string, elapsedSeconds: number, now: number = nowSeconds()): ReviewEvent {
    const pair = this.getPair(pairId);
    pair.timeout_count += 1;
    pair.current_interval = this.config.failIntervalReset;
    pair.next_due = now + pair.current_interval;
    validatePairConsistency(pair);

    return this.buildEvent(pairId, ReviewResult.TIMEOUT, elapsedSeconds, now, null, "timeout");
  }

  static getSessionStats(events: readonly ReviewEvent[]): SessionStats {
    const total = events.length;
    const passed = events.filter((e) => e.result === ReviewResult.PASS).length;
    const failed = events.filter((e) => e.result === ReviewResult.FAIL).length;
    const timedOut = events.filter((e) => e.result === ReviewResult.TIMEOUT).length;
    const responses = passed + failed;

    if (total - timedOut !== responses) {
      throw new Error("Session consistency error: total responses - timed_out must equal responses");
    }

    return {
      total,
      passed,
      failed,
      timedOut,
      responses,
      passRate: total ? passed / total : 0,
    };
  }

  private getPair(pairId: string): PairState {
    const pair = this.pairById.get(pairId);
    if (!pair) throw new Error(`Unknown pair_id: ${pairId}`);
    validatePairConsistency(pair);
    return pair;
  }

  private buildEvent(
    pairId: string,
    result: ReviewResult,
    elapsedSeconds: number,
    now: number,
    userAnswer: string | null,
    reason: string | null,
  ): ReviewEvent {
    const item = this.itemById.get(pairId);
    if (!item) throw new Error(`Unknown pair_id in deck: ${pairId}`);

    return {
      pair_id: pairId,
      term: item.term,
      result,
      elapsed_seconds: elapsedSeconds,
      timestamp: new Date(now * 1000).toISOString(),
      timeout_seconds: this.config.timeoutSeconds,
      user_answer: userAnswer,
      reason,
    };
  }
}
