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
  /**
   * When the user revealed the answers (or started typing one). The timer
   * measures recall only, so it stops here and can no longer time out.
   */
  revealedAt: number | null;
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

    this.activeReview = this.makeActive(due, now, null);
    this.persistActiveReview();
    return due;
  }

  /** Remaining recall time, frozen once revealed. Null when nothing is active. */
  timeRemaining(now: number): number | null {
    const active = this.activeReview;
    if (!active) return null;
    return active.timer.remaining(active.revealedAt ?? now);
  }

  /** Stop the recall timer and show the answers. Throws if already timed out. */
  revealAnswers(now: number): string[] {
    const active = this.ensureActive();
    if (active.revealedAt === null) {
      this.enforceNotTimedOut(now);
      active.revealedAt = now;
      this.persistActiveReview();
    }
    return [...active.answers];
  }

  /** Give the current pair a fresh countdown (e.g. returning to the app). No-op once revealed. */
  restartTimer(now: number): void {
    const active = this.activeReview;
    if (active && active.revealedAt === null) {
      active.timer = new ReviewTimer(now, active.timer.timeoutMs);
      this.persistActiveReview();
    }
  }

  /** Quit mid-review: drop the current pair without recording anything. */
  abandonActiveReview(): void {
    if (!this.activeReview) return;
    this.activeReview = null;
    this.callbacks.clearActiveReview?.();
  }

  activeReviewSnapshot(): ActiveReviewSnapshot | null {
    const active = this.activeReview;
    if (!active) return null;
    return {
      deckId: this.engine.deck.id,
      pairId: active.pairId,
      startedAt: active.timer.startedAt,
      revealed: active.revealedAt !== null,
    };
  }

  /**
   * Resume a review saved before a reload. The countdown restarts in full.
   * Returns false (and restores nothing) if the snapshot belongs to another
   * deck or its pair no longer exists or is burned.
   */
  restoreActiveReview(snapshot: ActiveReviewSnapshot | null, now: number): boolean {
    if (snapshot === null) return false;
    if (this.activeReview) throw new Error("Cannot restore review while another review is active");
    if (snapshot.deckId !== this.engine.deck.id) return false;

    const item = this.engine.getItem(snapshot.pairId);
    const pair = this.engine.getPairState(snapshot.pairId);
    if (!item || !pair || !this.engine.isReviewable(pair)) return false;

    this.activeReview = this.makeActive(item, now, snapshot.revealed ? now : null);
    return true;
  }

  /** Recalled one of the accepted answers (requires reveal): up one level. */
  gradePass(userAnswer: string | null, now: number): ReviewEvent {
    const active = this.ensureRevealed();
    return this.finalizeEvent(this.engine.recordPass(active.pairId, this.elapsed(active, now), userAnswer, now));
  }

  /** Didn't get it (requires reveal). */
  gradeFail(userAnswer: string | null, now: number): ReviewEvent {
    const active = this.ensureRevealed();
    return this.finalizeEvent(this.engine.recordFail(active.pairId, this.elapsed(active, now), userAnswer, now));
  }

  /**
   * "Something else" on a pair that has answers (requires reveal): the typed
   * answer is saved to the deck, and the pair keeps its level. Typing one of
   * the accepted answers counts as a normal pass.
   */
  submitOther(answer: string, now: number): ReviewEvent {
    const active = this.ensureRevealed();
    if (active.answers.length === 0) throw new Error("This pair has no answers yet; use submitNewAnswer");
    const trimmed = this.requireAnswer(answer);
    if (active.answers.includes(trimmed)) return this.gradePass(trimmed, now);
    this.addToDeck(active, trimmed, now);
    return this.finalizeEvent(this.engine.recordOther(active.pairId, this.elapsed(active, now), trimmed, now));
  }

  /**
   * First answer for a pair with none: saved to the deck and graded a pass.
   * Needs no reveal; throws if the recall time ran out before typing began.
   */
  submitNewAnswer(answer: string, now: number): ReviewEvent {
    const active = this.ensureActive();
    if (active.answers.length > 0) throw new Error("This pair already has answers; use submitOther");
    const trimmed = this.requireAnswer(answer);
    if (active.revealedAt === null) this.enforceNotTimedOut(now);
    this.addToDeck(active, trimmed, now);
    return this.finalizeEvent(this.engine.recordPass(active.pairId, this.elapsed(active, now), trimmed, now));
  }

  /** Auto-fail and finalize if the recall time ran out (never after reveal). */
  checkTimeout(now: number): ReviewEvent | null {
    const active = this.activeReview;
    if (!active || active.revealedAt !== null || !active.timer.isTimedOut(now)) return null;
    return this.finalizeEvent(this.engine.recordTimeout(active.pairId, now, active.timer.timeoutMs));
  }

  getSessionStats(): SessionStats {
    return ReviewEngine.getSessionStats(this.reviewedEvents);
  }

  private makeActive(item: DeckItem, now: number, revealedAt: number | null): ActiveReview {
    return {
      pairId: item.id,
      term: item.term,
      answers: [...item.answers],
      timer: new ReviewTimer(now, this.engine.timeoutFor(item.id)),
      revealedAt,
    };
  }

  /** Recall time: from start until reveal (or now, if not revealed). */
  private elapsed(active: ActiveReview, now: number): number {
    return active.timer.elapsed(active.revealedAt ?? now);
  }

  private requireAnswer(answer: string): string {
    const trimmed = answer.trim();
    if (trimmed === "") throw new Error("Answer can't be blank");
    return trimmed;
  }

  private addToDeck(active: ActiveReview, answer: string, now: number): void {
    const deck = this.engine.deck;
    if (addAnswerToPair(deck, active.pairId, answer, now)) this.callbacks.saveDeck?.(deck);
    active.answers = [...(this.engine.getItem(active.pairId)?.answers ?? [answer])];
  }

  private ensureActive(): ActiveReview {
    if (!this.activeReview) throw new Error("No active review");
    return this.activeReview;
  }

  private enforceNotTimedOut(now: number): void {
    if (this.checkTimeout(now)) throw new Error("Active review already timed out");
  }

  private ensureRevealed(): ActiveReview {
    const active = this.ensureActive();
    if (active.revealedAt === null) throw new Error("Must reveal answers before grading");
    return active;
  }

  private finalizeEvent(event: ReviewEvent): ReviewEvent {
    this.reviewedEvents.push(event);
    this.callbacks.appendEvent?.(event);
    this.callbacks.saveProgress?.(this.engine.pairs);
    this.callbacks.clearActiveReview?.();
    this.activeReview = null;
    return event;
  }

  private persistActiveReview(): void {
    const snapshot = this.activeReviewSnapshot();
    if (snapshot) this.callbacks.saveActiveReview?.(snapshot);
  }
}
