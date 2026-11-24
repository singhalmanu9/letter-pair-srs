import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/config";
import { ReviewEngine } from "../src/lib/engine";
import { ReviewResult, makePairState, makeReviewEvent, type Deck, type PairState } from "../src/lib/schemas";

const config = DEFAULT_CONFIG;
const expectedPassInterval = (current: number) =>
  Math.max(1, Math.round(current * config.passIntervalMultiplier));

const makeEngine = (items: [string, string][], pairs: PairState[]) => {
  const deck: Deck = { version: "1.0", items: items.map(([id, term]) => ({ id, term, answers: ["x"] })) };
  return new ReviewEngine(deck, { version: "1.0", pairs }, config);
};

describe("ReviewEngine", () => {
  it("get due pair returns earliest due", () => {
    const engine = makeEngine(
      [["q1", "AC"], ["q2", "BD"]],
      [
        makePairState({ pair_id: "q1", next_due: 90, current_interval: 60 }),
        makePairState({ pair_id: "q2", next_due: 95, current_interval: 60 }),
      ],
    );
    expect(engine.getDuePair(100)?.id).toBe("q1");
  });

  it("get due pair is null when nothing is due", () => {
    const engine = makeEngine([["q1", "AC"]], [makePairState({ pair_id: "q1", next_due: 200, current_interval: 60 })]);
    expect(engine.getDuePair(100)).toBeNull();
    expect(engine.secondsUntilNextDue(100)).toBe(100);
  });

  it("record pass updates counts, schedule and history", () => {
    const pair = makePairState({
      pair_id: "q1",
      next_due: 100,
      current_interval: 100,
      response_count: 2,
      pass_count: 1,
      fail_count: 1,
    });
    const engine = makeEngine([["q1", "AC"]], [pair]);

    const event = engine.recordPass("q1", 7.25, "apple", 200);

    const expected = expectedPassInterval(100);
    expect(pair).toMatchObject({
      response_count: 3,
      pass_count: 2,
      fail_count: 1,
      timeout_count: 0,
      current_interval: expected,
      next_due: 200 + expected,
      answer_history: { apple: 1 },
    });
    expect(event).toEqual({
      pair_id: "q1",
      term: "AC",
      result: ReviewResult.PASS,
      elapsed_seconds: 7.25,
      timeout_seconds: config.timeoutSeconds,
      user_answer: "apple",
      reason: null,
      timestamp: "1970-01-01T00:03:20.000Z",
    });
  });

  it("record fail resets interval and returns a fail event", () => {
    const pair = makePairState({ pair_id: "q1", next_due: 100, current_interval: 300 });
    const engine = makeEngine([["q1", "AC"]], [pair]);

    const event = engine.recordFail("q1", 8, "apples", 250);

    expect(pair).toMatchObject({
      response_count: 1,
      pass_count: 0,
      fail_count: 1,
      timeout_count: 0,
      current_interval: config.failIntervalReset,
      next_due: 250 + config.failIntervalReset,
      answer_history: { apples: 1 },
    });
    expect(event.result).toBe(ReviewResult.FAIL);
    expect(event.user_answer).toBe("apples");
    expect(event.reason).toBeNull();
  });

  it("record timeout is treated as a fail for scheduling", () => {
    const pair = makePairState({
      pair_id: "q1",
      next_due: 100,
      current_interval: 300,
      response_count: 5,
      pass_count: 3,
      fail_count: 2,
    });
    const engine = makeEngine([["q1", "AC"]], [pair]);

    const event = engine.recordTimeout("q1", config.timeoutSeconds, 400);

    expect(pair).toMatchObject({
      response_count: 5,
      pass_count: 3,
      fail_count: 2,
      timeout_count: 1,
      current_interval: config.failIntervalReset,
      next_due: 400 + config.failIntervalReset,
      answer_history: {},
    });
    expect(event.result).toBe(ReviewResult.TIMEOUT);
    expect(event.user_answer).toBeNull();
    expect(event.reason).toBe("timeout");
  });

  it("session stats", () => {
    const base = { elapsed_seconds: 3, timestamp: "2026-03-31T10:00:00", timeout_seconds: config.timeoutSeconds };
    const stats = ReviewEngine.getSessionStats([
      makeReviewEvent({ ...base, pair_id: "q1", term: "AC", result: ReviewResult.PASS }),
      makeReviewEvent({ ...base, pair_id: "q2", term: "BD", result: ReviewResult.FAIL }),
      makeReviewEvent({ ...base, pair_id: "q3", term: "CE", result: ReviewResult.TIMEOUT, reason: "timeout" }),
    ]);
    expect(stats).toMatchObject({ total: 3, passed: 1, failed: 1, timedOut: 1, responses: 2 });
    expect(stats.passRate).toBeCloseTo(1 / 3);
  });
});
