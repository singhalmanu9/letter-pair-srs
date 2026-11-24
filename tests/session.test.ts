import { beforeEach, describe, expect, it } from "vitest";
import { ReviewEngine } from "../src/lib/engine";
import { ReviewResult, type ActiveReviewSnapshot, type PairState, type ReviewEvent } from "../src/lib/schemas";
import { SessionController } from "../src/lib/session";
import { config, HOUR, makeDeck, makePair } from "./helpers";

const T = config.timeoutMs;

describe("SessionController", () => {
  let pairs: PairState[];
  let session: SessionController;
  let progressSaves: number;
  let events: ReviewEvent[];
  let snapshots: ActiveReviewSnapshot[];
  let clears: number;

  const pair = (id: string) => pairs.find((p) => p.pairId === id)!;

  beforeEach(() => {
    pairs = [makePair("q1", { nextDueAt: 10 }), makePair("q2", { nextDueAt: 20 })];
    const deck = makeDeck([
      ["q1", "AC", ["apple", "apricot"]],
      ["q2", "BD", ["boat"]],
    ]);
    progressSaves = 0;
    events = [];
    snapshots = [];
    clears = 0;
    session = new SessionController(new ReviewEngine(deck, pairs, config), {
      saveProgress: () => {
        progressSaves += 1;
      },
      appendEvent: (e) => events.push(e),
      saveActiveReview: (s) => snapshots.push(s),
      clearActiveReview: () => {
        clears += 1;
      },
    });
  });

  it("starts the earliest due pair with a full timer", () => {
    expect(session.startNextReview(12)?.id).toBe("q1");
    expect(session.activeReview?.pairId).toBe("q1");
    expect(session.timeRemaining(12)).toBe(T);
  });

  it("refuses to start while a review is active", () => {
    session.startNextReview(12);
    expect(() => session.startNextReview(13)).toThrow();
  });

  it("returns null when nothing is due", () => {
    expect(session.startNextReview(5)).toBeNull();
    expect(session.activeReview).toBeNull();
  });

  it("reveal then pass records the event and persists", () => {
    session.startNextReview(12);
    expect(session.revealAnswers(13)).toEqual(["apple", "apricot"]);

    const event = session.gradePass("apple", 3012);
    expect(event).toMatchObject({ result: ReviewResult.PASS, userAnswer: "apple", elapsedMs: 3000, timeoutMs: T });
    expect(session.activeReview).toBeNull();
    expect(session.reviewedEvents).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(progressSaves).toBe(1);
    expect(pair("q1")).toMatchObject({ stage: 1, nextDueAt: 3012 + 4 * HOUR, passCount: 1 });
  });

  it("fail updates the pair", () => {
    session.startNextReview(12);
    session.revealAnswers(13);
    session.gradeFail("wrong", 16);
    expect(pair("q1")).toMatchObject({ stage: 1, failCount: 1, responseCount: 1, answerHistory: { wrong: 1 } });
  });

  it("grading without reveal throws", () => {
    session.startNextReview(12);
    expect(() => session.gradeFail("wrong", 13)).toThrow(/reveal/);
  });

  it("timeout records once, without a response, and blocks grading and reveal", () => {
    session.startNextReview(12);
    const timeoutAt = 12 + T;

    const event = session.checkTimeout(timeoutAt);
    expect(event).toMatchObject({ result: ReviewResult.TIMEOUT, reason: "timeout", elapsedMs: T });
    expect(pair("q1")).toMatchObject({ timeoutCount: 1, responseCount: 0 });

    expect(session.checkTimeout(timeoutAt + 5)).toBeNull();
    expect(events).toHaveLength(1);
    expect(progressSaves).toBe(1);
    expect(() => session.gradePass("apple", timeoutAt + 5)).toThrow();
    expect(() => session.revealAnswers(timeoutAt + 5)).toThrow();
  });

  it("grading after the deadline records a timeout instead", () => {
    session.startNextReview(12);
    session.revealAnswers(13);
    expect(() => session.gradePass("apple", 12 + T)).toThrow(/timed out/);
    expect(events.at(-1)?.result).toBe(ReviewResult.TIMEOUT);
  });

  it("session stats match recorded events", () => {
    session.startNextReview(12);
    session.revealAnswers(13);
    session.gradePass("apple", 15);
    session.startNextReview(22);
    session.revealAnswers(23);
    session.gradeFail("wrong", 24);

    expect(session.getSessionStats()).toMatchObject({ total: 2, passed: 1, failed: 1, timedOut: 0, responses: 2 });
  });

  it("start and reveal save snapshots; grading clears", () => {
    session.startNextReview(12);
    expect(snapshots.at(-1)).toEqual({ deckId: "deck1", pairId: "q1", startedAt: 12, revealed: false });
    session.revealAnswers(13);
    expect(snapshots.at(-1)?.revealed).toBe(true);
    session.gradePass(null, 15);
    expect(clears).toBe(1);
  });

  describe("restore", () => {
    const snap = (overrides: Partial<ActiveReviewSnapshot> = {}): ActiveReviewSnapshot => ({
      deckId: "deck1",
      pairId: "q2",
      startedAt: 1,
      revealed: true,
      ...overrides,
    });

    it("resumes with a fresh timer and current answers", () => {
      expect(session.restoreActiveReview(snap(), 5000)).toBe(true);
      expect(session.activeReview).toMatchObject({ pairId: "q2", term: "BD", answers: ["boat"], revealed: true });
      expect(session.timeRemaining(5000)).toBe(T);
      expect(session.checkTimeout(5000 + T - 1)).toBeNull();

      session.gradeFail("wrong", 5003);
      expect(pair("q2").failCount).toBe(1);
    });

    it("ignores snapshots for another deck, a missing pair, or a burned pair", () => {
      expect(session.restoreActiveReview(snap({ deckId: "other" }), 0)).toBe(false);
      expect(session.restoreActiveReview(snap({ pairId: "gone" }), 0)).toBe(false);
      pair("q2").stage = 9;
      pair("q2").nextDueAt = null;
      expect(session.restoreActiveReview(snap(), 0)).toBe(false);
      expect(session.activeReview).toBeNull();
    });

    it("no snapshot is a no-op", () => {
      expect(session.restoreActiveReview(null, 0)).toBe(false);
      expect(session.startNextReview(12)?.id).toBe("q1");
    });
  });
});
