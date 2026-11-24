import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/config";
import { ReviewEngine } from "../src/lib/engine";
import { ReviewResult, makePairState, type ReviewEvent, type SRSState } from "../src/lib/schemas";
import { SessionController, type ActiveReviewSnapshot } from "../src/lib/session";

const config = DEFAULT_CONFIG;

describe("SessionController", () => {
  let state: SRSState;
  let session: SessionController;
  let savedStates: SRSState[];
  let appendedEvents: ReviewEvent[];

  const pair = (id: string) => state.pairs.find((p) => p.pair_id === id)!;

  beforeEach(() => {
    state = {
      version: "1.0",
      pairs: [
        makePairState({ pair_id: "q1", next_due: 10, current_interval: 60 }),
        makePairState({ pair_id: "q2", next_due: 20, current_interval: 60 }),
      ],
    };
    const engine = new ReviewEngine(
      {
        version: "1.0",
        items: [
          { id: "q1", term: "AC", answers: ["apple", "apricot"] },
          { id: "q2", term: "BD", answers: ["boat"] },
        ],
      },
      state,
      config,
    );
    savedStates = [];
    appendedEvents = [];
    session = new SessionController(engine, {
      saveState: (s) => savedStates.push(s),
      appendEvent: (e) => appendedEvents.push(e),
    });
  });

  it("start next review selects the due pair and sets the timer", () => {
    const item = session.startNextReview(12);
    expect(item?.id).toBe("q1");
    expect(session.activeReview?.pairId).toBe("q1");
    expect(session.timeRemaining(12)).toBe(config.timeoutSeconds);
  });

  it("start next review throws when a review is active", () => {
    session.startNextReview(12);
    expect(() => session.startNextReview(13)).toThrow();
  });

  it("reveal then pass records the event and persists", () => {
    session.startNextReview(12);
    expect(session.revealAnswers(13)).toEqual(["apple", "apricot"]);

    const event = session.gradePass("apple", 15);
    expect(event.result).toBe(ReviewResult.PASS);
    expect(event.user_answer).toBe("apple");
    expect(event.timeout_seconds).toBe(config.timeoutSeconds);
    expect(event.elapsed_seconds).toBeCloseTo(3);

    expect(session.activeReview).toBeNull();
    expect(session.reviewedEvents).toHaveLength(1);
    expect(appendedEvents).toHaveLength(1);
    expect(savedStates).toHaveLength(1);
  });

  it("grade pass updates schedule and counters", () => {
    const initialInterval = pair("q1").current_interval;
    session.startNextReview(12);
    session.revealAnswers(13);
    session.gradePass("apple", 15);

    const expected = Math.max(1, Math.round(initialInterval * config.passIntervalMultiplier));
    expect(pair("q1")).toMatchObject({
      pass_count: 1,
      fail_count: 0,
      timeout_count: 0,
      response_count: 1,
      current_interval: expected,
      next_due: 15 + expected,
      answer_history: { apple: 1 },
    });
  });

  it("grade fail updates schedule and counters", () => {
    session.startNextReview(12);
    session.revealAnswers(13);
    session.gradeFail("wrong", 16);

    expect(pair("q1")).toMatchObject({
      pass_count: 0,
      fail_count: 1,
      timeout_count: 0,
      response_count: 1,
      current_interval: config.failIntervalReset,
      next_due: 16 + config.failIntervalReset,
      answer_history: { wrong: 1 },
    });
  });

  it("timeout updates schedule without incrementing responses", () => {
    session.startNextReview(12);
    const timeoutAt = 12 + config.timeoutSeconds;
    session.checkTimeout(timeoutAt);

    expect(pair("q1")).toMatchObject({
      pass_count: 0,
      fail_count: 0,
      timeout_count: 1,
      response_count: 0,
      current_interval: config.failIntervalReset,
      next_due: timeoutAt + config.failIntervalReset,
      answer_history: {},
    });
  });

  it("grading without reveal throws", () => {
    session.startNextReview(12);
    expect(() => session.gradeFail("wrong", 13)).toThrow();
  });

  it("timeout records once and blocks grading", () => {
    session.startNextReview(12);
    const timeoutAt = 12 + config.timeoutSeconds;

    const event = session.checkTimeout(timeoutAt);
    expect(event?.result).toBe(ReviewResult.TIMEOUT);
    expect(event?.reason).toBe("timeout");
    expect(event?.elapsed_seconds).toBe(config.timeoutSeconds);

    expect(session.checkTimeout(timeoutAt + 5)).toBeNull();
    expect(session.reviewedEvents).toHaveLength(1);
    expect(appendedEvents).toHaveLength(1);
    expect(savedStates).toHaveLength(1);

    expect(() => session.gradePass("apple", timeoutAt + 5)).toThrow();
  });

  it("reveal after timeout throws", () => {
    session.startNextReview(12);
    const timeoutAt = 12 + config.timeoutSeconds;
    session.checkTimeout(timeoutAt);
    expect(() => session.revealAnswers(timeoutAt + 1)).toThrow();
  });

  it("returns null when no pair is due", () => {
    expect(session.startNextReview(5)).toBeNull();
    expect(session.activeReview).toBeNull();
  });

  it("session stats match recorded events", () => {
    session.startNextReview(12);
    session.revealAnswers(13);
    session.gradePass("apple", 15);

    session.startNextReview(22);
    session.revealAnswers(23);
    session.gradeFail("wrong", 24);

    expect(session.getSessionStats()).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
      timedOut: 0,
      responses: 2,
    });
  });
});

describe("SessionController recovery", () => {
  let state: SRSState;
  let session: SessionController;
  let savedSnapshots: ActiveReviewSnapshot[];
  let clearedCount: number;
  let appendedEvents: ReviewEvent[];
  let savedStates: SRSState[];

  const snapshot = (overrides: Partial<ActiveReviewSnapshot> = {}): ActiveReviewSnapshot => ({
    pair_id: "q1",
    term: "AC",
    answers: ["apple", "apricot"],
    started_at: 12,
    timeout_seconds: config.timeoutSeconds,
    revealed: false,
    ...overrides,
  });

  beforeEach(() => {
    state = { version: "1.0", pairs: [makePairState({ pair_id: "q1", next_due: 10, current_interval: 60 })] };
    const engine = new ReviewEngine(
      { version: "1.0", items: [{ id: "q1", term: "AC", answers: ["apple", "apricot"] }] },
      state,
      config,
    );
    savedSnapshots = [];
    clearedCount = 0;
    appendedEvents = [];
    savedStates = [];
    session = new SessionController(engine, {
      saveState: (s) => savedStates.push(s),
      appendEvent: (e) => appendedEvents.push(e),
      saveActiveReview: (s) => savedSnapshots.push(s),
      clearActiveReview: () => {
        clearedCount += 1;
      },
    });
  });

  it("start and reveal persist a snapshot, grading clears it", () => {
    session.startNextReview(12);
    expect(savedSnapshots).toHaveLength(1);
    expect(savedSnapshots.at(-1)?.revealed).toBe(false);

    session.revealAnswers(13);
    expect(savedSnapshots).toHaveLength(2);
    expect(savedSnapshots.at(-1)?.revealed).toBe(true);

    expect(session.gradePass("apple", 15).result).toBe(ReviewResult.PASS);
    expect(session.activeReview).toBeNull();
    expect(clearedCount).toBe(1);
    expect(savedStates).toHaveLength(1);
    expect(appendedEvents).toHaveLength(1);
  });

  it("restores an active review and continues the flow", () => {
    session.restoreActiveReview(snapshot({ revealed: true }), 1000);
    expect(session.activeReview?.revealed).toBe(true);
    expect(session.activeReview?.timer.startedAt).toBe(1000);

    // Must not time out based on the old snapshot timestamp.
    expect(session.checkTimeout(1000 + config.timeoutSeconds - 1)).toBeNull();

    expect(session.gradeFail("wrong", 1003).result).toBe(ReviewResult.FAIL);
    expect(state.pairs[0]).toMatchObject({
      response_count: 1,
      fail_count: 1,
      next_due: 1003 + config.failIntervalReset,
    });
    expect(clearedCount).toBe(1);
  });

  it("restore restarts the full timeout window", () => {
    const restoreNow = 5000;
    session.restoreActiveReview(snapshot({ started_at: 1 }), restoreNow);
    expect(session.timeRemaining(restoreNow)).toBe(config.timeoutSeconds);
    expect(session.checkTimeout(restoreNow + config.timeoutSeconds)?.result).toBe(ReviewResult.TIMEOUT);
  });

  it("restoring an invalid snapshot throws", () => {
    expect(() => session.restoreActiveReview({ pair_id: "q1" })).toThrow();
  });

  it("restoring with no snapshot is a no-op", () => {
    session.restoreActiveReview(null);
    expect(session.activeReview).toBeNull();
    expect(session.reviewedEvents).toHaveLength(0);
    expect(session.startNextReview(12)?.id).toBe("q1");
  });
});
