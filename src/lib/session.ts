/** Session orchestration: review flow, timeout handling and persistence hooks. */

import { nowSeconds } from "./config";
import { ReviewEngine, type SessionStats } from "./engine";
import type { DeckItem, ReviewEvent, SRSState } from "./schemas";
import { ReviewTimer } from "./timer";

/** In-flight state for the pair currently shown. */
export interface ActiveReview {
  pairId: string;
  term: string;
  answers: string[];
  timer: ReviewTimer;
  revealed: boolean;
}

/** Serializable form of an active review (snake_case, matches the Python format). */
export interface ActiveReviewSnapshot {
  pair_id: string;
  term: string;
  answers: string[];
  started_at: number;
  timeout_seconds: number;
  revealed: boolean;
}

export interface SessionCallbacks {
  saveState?: (state: SRSState) => void;
  appendEvent?: (event: ReviewEvent) => void;
  saveActiveReview?: (snapshot: ActiveReviewSnapshot) => void;
  clearActiveReview?: () => void;
}

const SNAPSHOT_KEYS: readonly (keyof ActiveReviewSnapshot)[] = [
  "pair_id",
  "term",
  "answers",
  "started_at",
  "timeout_seconds",
  "revealed",
];

export class SessionController {
  activeReview: ActiveReview | null = null;
  readonly reviewedEvents: ReviewEvent[] = [];

  constructor(
    readonly engine: ReviewEngine,
    private readonly callbacks: SessionCallbacks = {},
  ) {}

  /** Start the next due review, or return null when nothing is due. */
  startNextReview(now: number = nowSeconds()): DeckItem | null {
    if (this.activeReview) throw new Error("Cannot start a new review while another review is active");

    const due = this.engine.getDuePair(now);
    if (!due) return null;

    this.activeReview = {
      pairId: due.id,
      term: due.term,
      answers: [...due.answers],
      timer: new ReviewTimer(now, this.engine.config.timeoutSeconds),
      revealed: false,
    };
    this.persistActiveReview();
    return due;
  }

  timeRemaining(now: number = nowSeconds()): number | null {
    return this.activeReview ? this.activeReview.timer.remaining(now) : null;
  }

  revealAnswers(now: number = nowSeconds()): string[] {
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
      pair_id: active.pairId,
      term: active.term,
      answers: [...active.answers],
      started_at: active.timer.startedAt,
      timeout_seconds: active.timer.timeoutSeconds,
      revealed: active.revealed,
    };
  }

  /** Restore an in-progress review. The countdown intentionally restarts in full. */
  restoreActiveReview(snapshot: Partial<ActiveReviewSnapshot> | null | undefined, now: number = nowSeconds()): void {
    if (snapshot == null) return;
    if (this.activeReview) throw new Error("Cannot restore review while another review is active");

    const missing = SNAPSHOT_KEYS.filter((key) => !(key in snapshot)).sort();
    if (missing.length) throw new Error(`Invalid session snapshot, missing: ${missing.join(", ")}`);

    const s = snapshot as ActiveReviewSnapshot;
    this.activeReview = {
      pairId: s.pair_id,
      term: s.term,
      answers: [...s.answers],
      timer: new ReviewTimer(now, Math.trunc(Number(s.timeout_seconds))),
      revealed: Boolean(s.revealed),
    };
  }

  gradePass(userAnswer: string | null = null, now: number = nowSeconds()): ReviewEvent {
    const active = this.ensureReadyForGrading(now);
    const event = this.engine.recordPass(active.pairId, active.timer.elapsed(now), userAnswer, now);
    this.finalizeEvent(event);
    return event;
  }

  gradeFail(userAnswer: string | null = null, now: number = nowSeconds()): ReviewEvent {
    const active = this.ensureReadyForGrading(now);
    const event = this.engine.recordFail(active.pairId, active.timer.elapsed(now), userAnswer, now);
    this.finalizeEvent(event);
    return event;
  }

  /** Auto-fail and finalize if the active review has timed out. */
  checkTimeout(now: number = nowSeconds()): ReviewEvent | null {
    const active = this.activeReview;
    if (!active || !active.timer.isTimedOut(now)) return null;

    const event = this.engine.recordTimeout(active.pairId, this.engine.config.timeoutSeconds, now);
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
    this.callbacks.saveState?.(this.engine.state);
    this.callbacks.clearActiveReview?.();
    this.activeReview = null;
  }

  private persistActiveReview(): void {
    const snapshot = this.activeReviewSnapshot();
    if (snapshot && this.callbacks.saveActiveReview) this.callbacks.saveActiveReview(snapshot);
  }
}
