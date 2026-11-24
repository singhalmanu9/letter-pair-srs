import { describe, expect, it } from "vitest";
import { ReviewEngine } from "../src/lib/engine";
import { ReviewResult, type PairState, type ReviewEvent } from "../src/lib/schemas";
import { config, DAY, HOUR, makeDeck, makePair } from "./helpers";

const engineFor = (pairs: PairState[]) =>
  new ReviewEngine(makeDeck(pairs.map((p, i) => [p.pairId, `T${i}`])), pairs, config);

describe("ReviewEngine", () => {
  it("returns the earliest due pair", () => {
    const engine = engineFor([makePair("q1", { nextDueAt: 95 }), makePair("q2", { nextDueAt: 90 })]);
    expect(engine.getDuePair(100)?.id).toBe("q2");
    expect(engine.dueCount(100)).toBe(2);
  });

  it("returns null when nothing is due, and reports time until the next", () => {
    const engine = engineFor([makePair("q1", { nextDueAt: 200 })]);
    expect(engine.getDuePair(100)).toBeNull();
    expect(engine.msUntilNextDue(100)).toBe(100);
  });

  it("never schedules burned pairs", () => {
    const engine = engineFor([makePair("q1", { stage: 9, nextDueAt: null })]);
    expect(engine.getDuePair(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(engine.msUntilNextDue(0)).toBeNull();
    expect(() => engine.recordPass("q1", 0, null, 0)).toThrow(/burned/);
  });

  it("requires progress to match the deck", () => {
    expect(() => new ReviewEngine(makeDeck([["q1", "AC"]]), [], config)).toThrow(/sync/);
    expect(() => new ReviewEngine(makeDeck([]), [makePair("q1")], config)).toThrow(/not found/);
  });

  it("pass moves up a stage and schedules the stage interval", () => {
    const pair = makePair("q1", { stage: 2, responseCount: 2, passCount: 1, failCount: 1 });
    const engine = new ReviewEngine(makeDeck([["q1", "AC"]]), [pair], config);

    const event = engine.recordPass("q1", 7250, "apple", 1000);

    expect(pair).toMatchObject({
      stage: 3,
      nextDueAt: 1000 + 1 * DAY,
      responseCount: 3,
      passCount: 2,
      failCount: 1,
      timeoutCount: 0,
      answerHistory: { apple: 1 },
      updatedAt: 1000,
    });
    expect(event).toEqual<ReviewEvent>({
      pairId: "q1",
      term: "AC",
      result: ReviewResult.PASS,
      stageBefore: 2,
      stageAfter: 3,
      elapsedMs: 7250,
      timeoutMs: config.timeoutMs,
      reviewedAt: 1000,
      userAnswer: "apple",
      reason: null,
    });
  });

  it("first pass of a new pair schedules Apprentice 1 (4 hours)", () => {
    const pair = makePair("q1");
    engineFor([pair]).recordPass("q1", 0, null, 0);
    expect(pair).toMatchObject({ stage: 1, nextDueAt: 4 * HOUR });
  });

  it("passing Enlightened burns the pair", () => {
    const pair = makePair("q1", { stage: 8 });
    engineFor([pair]).recordPass("q1", 0, null, 0);
    expect(pair).toMatchObject({ stage: 9, nextDueAt: null });
  });

  it("fail drops stages per the penalty and schedules the new stage", () => {
    const apprentice = makePair("q1", { stage: 3 });
    const guru = makePair("q2", { stage: 6 });
    const engine = engineFor([apprentice, guru]);

    const event = engine.recordFail("q1", 8000, "apples", 500);
    engine.recordFail("q2", 8000, null, 500);

    expect(apprentice).toMatchObject({
      stage: 2,
      nextDueAt: 500 + 8 * HOUR,
      responseCount: 1,
      failCount: 1,
      answerHistory: { apples: 1 },
    });
    expect(guru).toMatchObject({ stage: 4, nextDueAt: 500 + 2 * DAY });
    expect(event).toMatchObject({ result: ReviewResult.FAIL, stageBefore: 3, stageAfter: 2, reason: null });
  });

  it("timeout schedules like a fail without counting a response", () => {
    const pair = makePair("q1", { stage: 5, responseCount: 5, passCount: 3, failCount: 2 });
    const event = engineFor([pair]).recordTimeout("q1", 400);

    expect(pair).toMatchObject({
      stage: 3,
      nextDueAt: 400 + 1 * DAY,
      responseCount: 5,
      timeoutCount: 1,
      answerHistory: {},
    });
    expect(event).toMatchObject({
      result: ReviewResult.TIMEOUT,
      elapsedMs: config.timeoutMs,
      userAnswer: null,
      reason: "timeout",
    });
  });

  it("counts pairs per stage", () => {
    const engine = engineFor([makePair("a"), makePair("b"), makePair("c", { stage: 5 }), makePair("d", { stage: 9, nextDueAt: null })]);
    expect(engine.stageCounts()).toEqual([2, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("session stats", () => {
    const base = { term: "T", stageBefore: 0, stageAfter: 1, elapsedMs: 0, timeoutMs: 0, reviewedAt: 0, userAnswer: null };
    const stats = ReviewEngine.getSessionStats([
      { ...base, pairId: "q1", result: ReviewResult.PASS, reason: null },
      { ...base, pairId: "q2", result: ReviewResult.FAIL, reason: null },
      { ...base, pairId: "q3", result: ReviewResult.TIMEOUT, reason: "timeout" },
    ]);
    expect(stats).toMatchObject({ total: 3, passed: 1, failed: 1, timedOut: 1, responses: 2 });
    expect(stats.passRate).toBeCloseTo(1 / 3);
  });
});
