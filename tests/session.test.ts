import { beforeEach, describe, expect, it } from "vitest";
import { ReviewEngine } from "../src/lib/engine";
import { ReviewResult, type ActiveReviewSnapshot, type PairState, type ReviewEvent } from "../src/lib/schemas";
import { SessionController } from "../src/lib/session";
import { config, DAY, HOUR, makeDeck, makePair } from "./helpers";

const T = config.timer.staticMs;

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
    // Elapsed is recall time: start (12) to reveal (13), not to the tap.
    expect(event).toMatchObject({ result: ReviewResult.PASS, userAnswer: "apple", elapsedMs: 1, timeoutMs: T });
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

  it("the timer stops at reveal: no timeout afterwards and remaining time is frozen", () => {
    session.startNextReview(12);
    session.revealAnswers(1012);
    expect(session.timeRemaining(99_999)).toBe(T - 1000);
    expect(session.checkTimeout(12 + T * 5)).toBeNull();
    expect(session.gradePass("apple", 12 + T * 5).result).toBe(ReviewResult.PASS);
  });

  it("restartTimer gives a fresh countdown before reveal only", () => {
    session.startNextReview(12);
    session.restartTimer(5000);
    expect(session.timeRemaining(5000)).toBe(T);
    expect(snapshots.at(-1)?.startedAt).toBe(5000);
    session.revealAnswers(5001);
    session.restartTimer(9000);
    expect(session.timeRemaining(9000)).toBe(T - 1);
  });

  it("quitting drops the current pair without recording anything", () => {
    session.startNextReview(12);
    session.abandonActiveReview();
    expect(session.activeReview).toBeNull();
    expect(events).toEqual([]);
    expect(progressSaves).toBe(0);
    expect(clears).toBe(1);
    expect(pair("q1")).toMatchObject({ stage: 0, nextDueAt: 10, timeoutCount: 0, failCount: 0 });
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

  describe("new answers", () => {
    it("an unanswered pair passes by typing an answer, no reveal needed", () => {
      const deck = makeDeck([["u1", "AB", []]]);
      const unanswered = [makePair("u1")];
      const decksSaved: unknown[] = [];
      const s = new SessionController(new ReviewEngine(deck, unanswered, config), {
        saveDeck: (d) => decksSaved.push(d),
      });

      s.startNextReview(0);
      expect(s.activeReview?.answers).toEqual([]);
      expect(() => s.gradePass(null, 1)).toThrow(/reveal/);

      const event = s.submitNewAnswer("  Abbey Road ", 5000);
      expect(event).toMatchObject({ result: ReviewResult.PASS, userAnswer: "Abbey Road", stageAfter: 1, elapsedMs: 5000 });
      expect(deck.items[0]!.answers).toEqual(["Abbey Road"]);
      expect(decksSaved).toHaveLength(1);
      expect(unanswered[0]).toMatchObject({ stage: 1, answerHistory: { "Abbey Road": 1 } });
    });

    it("rejects a blank answer", () => {
      const deck = makeDeck([["u1", "AB", []]]);
      const s = new SessionController(new ReviewEngine(deck, [makePair("u1")], config));
      s.startNextReview(0);
      expect(() => s.submitNewAnswer("   ", 1)).toThrow(/blank/);
      expect(deck.items[0]!.answers).toEqual([]);
      expect(s.activeReview).not.toBeNull();
    });

    it("failing or timing out an unanswered pair brings it straight back", () => {
      const deck = makeDeck([["u1", "AB", []]]);
      const s = new SessionController(new ReviewEngine(deck, [makePair("u1")], config));
      s.startNextReview(0);
      s.checkTimeout(T);
      expect(s.startNextReview(T)?.id).toBe("u1");
    });

    it("something else on an answered pair saves the answer and keeps the level", () => {
      pair("q1").stage = 3;
      session.startNextReview(12);
      expect(() => session.submitOther("Ace", 13)).toThrow(/reveal/);
      session.revealAnswers(13);
      const event = session.submitOther(" Ace ", 14);

      expect(event).toMatchObject({ result: ReviewResult.OTHER, userAnswer: "Ace", stageBefore: 3, stageAfter: 3 });
      expect(session.engine.getItem("q1")!.answers).toEqual(["apple", "apricot", "Ace"]);
      expect(pair("q1")).toMatchObject({ stage: 3, nextDueAt: 14 + DAY, otherCount: 1, responseCount: 1, passCount: 0 });
      expect(pair("q1").answerHistory).toEqual({ Ace: 1 });
      expect(session.getSessionStats()).toMatchObject({ total: 1, other: 1, passed: 0, responses: 1 });
    });

    it("something else on a New pair keeps it New and due now", () => {
      session.startNextReview(12);
      session.revealAnswers(13);
      session.submitOther("Ace", 14);
      expect(pair("q1")).toMatchObject({ stage: 0, nextDueAt: 14 });
    });

    it("typing an existing answer as something else counts as a pass", () => {
      session.startNextReview(12);
      session.revealAnswers(13);
      expect(session.submitOther(" apple ", 14).result).toBe(ReviewResult.PASS);
      expect(session.engine.getItem("q1")!.answers).toEqual(["apple", "apricot"]);
    });

    it("each typed path is only for its kind of pair", () => {
      session.startNextReview(12);
      expect(() => session.submitNewAnswer("Ace", 13)).toThrow(/submitOther/);
    });

    it("times out instead if the deadline has passed", () => {
      const deck = makeDeck([["u1", "AB", []]]);
      const s = new SessionController(new ReviewEngine(deck, [makePair("u1")], config));
      s.startNextReview(0);
      expect(() => s.submitNewAnswer("Abbey", T)).toThrow(/timed out/);
      expect(deck.items[0]!.answers).toEqual([]);
    });
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
      expect(session.activeReview).toMatchObject({ pairId: "q2", term: "BD", answers: ["boat"], revealedAt: 5000 });
      expect(session.timeRemaining(5000)).toBe(T);
      expect(session.checkTimeout(5000 + T - 1)).toBeNull();

      session.gradeFail("wrong", 5003);
      expect(pair("q2").failCount).toBe(1);
    });

    it("restores a review of a pair with no answers", () => {
      session.engine.deck.items.find((i) => i.id === "q2")!.answers.length = 0;
      expect(session.restoreActiveReview(snap(), 0)).toBe(true);
      expect(session.activeReview?.answers).toEqual([]);
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
