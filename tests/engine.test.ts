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
      timeoutMs: config.timer.staticMs,
      reviewedAt: 1000,
      userAnswer: "apple",
      reason: null,
    });
  });

  it("first pass of a new pair schedules Level 1 (4 hours)", () => {
    const pair = makePair("q1");
    engineFor([pair]).recordPass("q1", 0, null, 0);
    expect(pair).toMatchObject({ stage: 1, nextDueAt: 4 * HOUR });
  });

  it("passing Level 8 burns the pair (Level 9)", () => {
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
      elapsedMs: config.timer.staticMs,
      userAnswer: null,
      reason: "timeout",
    });
  });

  it("counts pairs per stage", () => {
    const engine = engineFor([makePair("a"), makePair("b"), makePair("c", { stage: 5 }), makePair("d", { stage: 9, nextDueAt: null })]);
    expect(engine.stageCounts()).toEqual([2, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("reviews pairs with no answers like any other due pair", () => {
    const deck = makeDeck([["q1", "AB", []], ["q2", "AC", ["x"]]]);
    const engine = new ReviewEngine(deck, [makePair("q1", { nextDueAt: 0 }), makePair("q2", { nextDueAt: 50 })], config);

    expect(engine.getDuePair(100)?.id).toBe("q1");
    expect(engine.dueCount(100)).toBe(2);
    expect(engine.unansweredCount()).toBe(1);
    expect(engine.isUnanswered("q1")).toBe(true);
    expect(engine.stageCounts()[0]).toBe(2);
  });

  it("an unanswered pair can't pass until it has an answer", () => {
    const deck = makeDeck([["q1", "AB", []]]);
    const engine = new ReviewEngine(deck, [makePair("q1")], config);
    expect(() => engine.recordPass("q1", 0, "Abbey", 0)).toThrow(/needs an answer/);

    deck.items[0]!.answers.push("Abbey");
    engine.recordPass("q1", 0, "Abbey", 0);
    expect(engine.pairs[0]).toMatchObject({ stage: 1, nextDueAt: 4 * HOUR });
  });

  it("failing or timing out an unanswered pair keeps it New and due now", () => {
    const deck = makeDeck([["q1", "AB", []], ["q2", "AC", []]]);
    const engine = new ReviewEngine(deck, [makePair("q1"), makePair("q2")], config);

    const fail = engine.recordFail("q1", 0, null, 500);
    engine.recordTimeout("q2", 600);

    expect(engine.pairs[0]).toMatchObject({ stage: 0, nextDueAt: 500, failCount: 1 });
    expect(engine.pairs[1]).toMatchObject({ stage: 0, nextDueAt: 600, timeoutCount: 1 });
    expect(fail).toMatchObject({ stageBefore: 0, stageAfter: 0 });
  });

  it("syncPair sends a pair that lost all its answers back to New", () => {
    const deck = makeDeck([["q1", "AB", ["Abbey"]]]);
    const pair = makePair("q1", { stage: 7, nextDueAt: 99 * DAY, passCount: 6, responseCount: 6 });
    const engine = new ReviewEngine(deck, [pair], config);

    expect(engine.syncPair("q1", 1000)).toBe(false);
    deck.items[0]!.answers.length = 0;
    expect(engine.syncPair("q1", 1000)).toBe(true);
    expect(pair).toMatchObject({ stage: 0, nextDueAt: 1000, passCount: 6 });
    expect(engine.syncPair("q1", 2000)).toBe(false);
  });

  it("trims recorded answers and ignores blank ones", () => {
    const pair = makePair("q1");
    const engine = engineFor([pair]);
    engine.recordFail("q1", 0, "   ", 0);
    engine.recordFail("q1", 0, "  apple ", 0);
    expect(pair.answerHistory).toEqual({ apple: 1 });
  });

  it("dynamic timer shrinks recall time per level down to a minimum", () => {
    const timer = { mode: "dynamic" as const, staticMs: 10_000, dynamicStartMs: 10_000, dynamicStepMs: 1_000, dynamicMinMs: 4_000 };
    const pairs = [0, 1, 2, 5, 8].map((stage, i) => makePair(`p${i}`, { stage }));
    const engine = new ReviewEngine(makeDeck(pairs.map((p) => [p.pairId, p.pairId])), pairs, { ...config, timer });
    expect(pairs.map((p) => engine.timeoutFor(p.pairId))).toEqual([10_000, 10_000, 9_000, 6_000, 4_000]);
  });

  it("static timer gives every pair the same recall time", () => {
    const pairs = [makePair("a", { stage: 1 }), makePair("b", { stage: 8 })];
    const engine = engineFor(pairs);
    expect(engine.timeoutFor("a")).toBe(config.timer.staticMs);
    expect(engine.timeoutFor("b")).toBe(config.timer.staticMs);
  });

  it("events record the recall time the pair was given", () => {
    const timer = { ...config.timer, mode: "dynamic" as const };
    const pair = makePair("q1", { stage: 4 });
    const engine = new ReviewEngine(makeDeck([["q1", "AC"]]), [pair], { ...config, timer });
    expect(engine.recordPass("q1", 1, null, 0).timeoutMs).toBe(timer.dynamicStartMs - 3 * timer.dynamicStepMs);
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
