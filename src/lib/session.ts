/** Session orchestration: review flow, timeout handling and persistence hooks. */

import { ReviewEngine, type SessionStats } from "./engine";
import {
  addAnswerToPair,
  type ActiveReviewSnapshot,
  type Deck,
  type DeckItem,
  type PairState,
  type ReviewEvent,
} from "./schemas";
import { ReviewTimer } from "./timer";

/** In-flight state for the pair currently shown. */
export interface ActiveReview {
  pairId: string;
  term: string;
  /** Accepted answers. Empty means the user must come up with one. */
  answers: string[];
  timer: ReviewTimer;
  revealed: boolean;
}

/**
 * Persistence hooks. They're called synchronously and may return promises;
 * the caller is responsible for ordering and error handling (see WriteQueue).
 */
export interface SessionCallbacks {
  saveDeck?: (deck: Deck) => void;
  saveProgress?: (pairs: readonly PairState[]) => void;
  appendEvent?: (event: ReviewEvent) => void;
  saveActiveReview?: (snapshot: ActiveReviewSnapshot) => void;
  clearActiveReview?: () => void;
}

export class SessionController {
  activeReview: ActiveReview | null = null;
  readonly reviewedEvents: ReviewEvent[] = [];

  constructor(
    readonly engine: ReviewEngine,
    private readonly callbacks: SessionCallbacks = {},
  ) {}

  /** Start the next due review, or return null when nothing is due. */
  startNextReview(now: number): DeckItem | null {
    if (this.activeReview) throw new Error("Cannot start a new review while another review is active");

    const due = this.engine.getDuePair(now);
    if (!due) return null;

    this.activeReview = {
      pairId: due.id,
      term: due.term,
      answers: [...due.answers],
      timer: new ReviewTimer(now, this.engine.config.timeoutMs),
      revealed: false,
    };
    this.persistActiveReview();
    return due;
  }

  timeRemaining(now: number): number | null {
    return this.activeReview ? this.activeReview.timer.remaining(now) : null;
  }

  revealAnswers(now: number): string[] {
    const active = this.ensureActive();
    this.enforceNotTimedOut(now);
    active.revealed = true;
    this.persistActiveReview();
    return [...active.answers];
  }

  activeReviewSnapshot(): ActiveReviewSnapshot | null {
    const active = this.activeReview;
    if (!active) return null;
    return {
      deckId: this.engine.deck.id,
      pairId: active.pairId,
      startedAt: active.timer.startedAt,
      revealed: active.revealed,
    };
  }

  /**
   * Resume a review saved before a reload. The countdown restarts in full.
   * Returns false (and restores nothing) if the snapshot belongs to another
   * deck or its pair no longer exists or isn't reviewable (burned or no answers).
   */
  restoreActiveReview(snapshot: ActiveReviewSnapshot | null, now: number): boolean {
    if (snapshot === null) return false;
    if (this.activeReview) throw new Error("Cannot restore review while another review is active");
    if (snapshot.deckId !== this.engine.deck.id) return false;

    const item = this.engine.getItem(snapshot.pairId);
    const pair = this.engine.pairs.find((p) => p.pairId === snapshot.pairId);
    if (!item || !pair || !this.engine.isReviewable(pair)) return false;

    this.activeReview = {
      pairId: item.id,
      term: item.term,
      answers: [...item.answers],
      timer: new ReviewTimer(now, this.engine.config.timeoutMs),
      revealed: snapshot.revealed,
    };
    return true;
  }

  gradePass(userAnswer: string | null, now: number): ReviewEvent {
    const active = this.ensureReadyForGrading(now);
    const event = this.engine.recordPass(active.pairId, active.timer.elapsed(now), userAnswer, now);
    this.finalizeEvent(event);
    return event;
  }

  gradeFail(userAnswer: string | null, now: number): ReviewEvent {
    const active = this.ensureReadyForGrading(now);
    const event = this.engine.recordFail(active.pairId, active.timer.elapsed(now), userAnswer, now);
    this.finalizeEvent(event);
    return event;
  }

  /**
   * The user came up with an answer that isn't one of the accepted ones: save
   * it as a new accepted answer and grade the review a pass. For a pair with
   * no answers this is the only way to pass, and needs no reveal; otherwise
   * the answers must have been revealed first. Throws on a blank answer.
   */
  submitNewAnswer(answer: string, now: number): ReviewEvent {
    const active = this.ensureActive();
    const trimmed = answer.trim();
    if (trimmed === "") throw new Error("Answer can't be blank");
    if (active.answers.length > 0 && !active.revealed) throw new Error("Must reveal answers before grading");
    this.enforceNotTimedOut(now);

    const deck = this.engine.deck;
    if (addAnswerToPair(deck, active.pairId, trimmed, now)) this.callbacks.saveDeck?.(deck);
    active.answers = [...(this.engine.getItem(active.pairId)?.answers ?? [trimmed])];

    const event = this.engine.recordPass(active.pairId, active.timer.elapsed(now), trimmed, now);
    this.finalizeEvent(event);
    return event;
  }

  /** Auto-fail and finalize if the active review has timed out. */
  checkTimeout(now: number): ReviewEvent | null {
    const active = this.activeReview;
    if (!active || !active.timer.isTimedOut(now)) return null;

    const event = this.engine.recordTimeout(active.pairId, now);
    this.finalizeEvent(event);
    return event;
  }

  getSessionStats(): SessionStats {
    return ReviewEngine.getSessionStats(this.reviewedEvents);
  }

  private ensureActive(): ActiveReview {
    if (!this.activeReview) throw new Error("No active review");
    return this.activeReview;
  }

  private enforceNotTimedOut(now: number): void {
    if (this.checkTimeout(now)) throw new Error("Active review already timed out");
  }

  private ensureReadyForGrading(now: number): ActiveReview {
    const active = this.ensureActive();
    if (!active.revealed) throw new Error("Must reveal answers before grading");
    this.enforceNotTimedOut(now);
    return active;
  }

  private finalizeEvent(event: ReviewEvent): void {
    this.reviewedEvents.push(event);
    this.callbacks.appendEvent?.(event);
    this.callbacks.saveProgress?.(this.engine.pairs);
    this.callbacks.clearActiveReview?.();
    this.activeReview = null;
  }

  private persistActiveReview(): void {
    const snapshot = this.activeReviewSnapshot();
    if (snapshot) this.callbacks.saveActiveReview?.(snapshot);
  }
}
