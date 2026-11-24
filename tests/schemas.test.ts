import { describe, expect, it } from "vitest";
import { nowSeconds } from "../src/lib/config";
import {
  ReviewResult,
  addAnswer,
  makePairState,
  makeReviewEvent,
  mostCommonAnswer,
  pairStateFromJSON,
  recordAnswer,
  reviewEventFromJSON,
  totalResponses,
  validatePairConsistency,
  type DeckItem,
} from "../src/lib/schemas";

/** Simulate a save/load cycle. */
const roundtrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe("schemas", () => {
  it("deck item roundtrip", () => {
    const item: DeckItem = { id: "q1", term: "Apple", answers: ["apple", "APPLE"] };
    const restored = roundtrip(item) as DeckItem;
    expect(restored).toEqual({ id: "q1", term: "Apple", answers: ["apple", "APPLE"] });
  });

  it("deck item add answer", () => {
    const item: DeckItem = { id: "q1", term: "Apple", answers: ["apple"] };
    expect(addAnswer(item, "pomme")).toBe(true);
    expect(item.answers).toContain("pomme");
    expect(addAnswer(item, "pomme")).toBe(false);
    expect(item.answers).toHaveLength(2);
  });

  it("pair state roundtrip", () => {
    const due = nowSeconds() + 123.45;
    const pair = makePairState({
      pair_id: "q1",
      next_due: due,
      current_interval: 120,
      response_count: 7,
      pass_count: 5,
      fail_count: 2,
      timeout_count: 3,
      answer_history: { apple: 3, pomme: 1 },
    });
    const restored = pairStateFromJSON(roundtrip(pair) as Record<string, unknown>);
    expect(restored).toEqual(pair);
    expect(totalResponses(restored)).toBe(10);
    expect(validatePairConsistency(restored)).toBe(true);
  });

  it("pair state answer tracking", () => {
    const pair = makePairState({ pair_id: "q1", next_due: nowSeconds(), current_interval: 120 });
    for (const answer of ["apple", "pomme", "apple", "apple"]) recordAnswer(pair, answer);
    expect(pair.answer_history).toEqual({ apple: 3, pomme: 1 });
    expect(mostCommonAnswer(pair)).toBe("apple");
  });

  it("pair state answer history persists through serialization", () => {
    const pair = makePairState({ pair_id: "q1", next_due: nowSeconds(), current_interval: 120 });
    for (const answer of ["alpha", "alpha", "beta"]) recordAnswer(pair, answer);
    const restored = pairStateFromJSON(roundtrip(pair) as Record<string, unknown>);
    expect(restored.answer_history).toEqual({ alpha: 2, beta: 1 });
  });

  it("pair state consistency validation", () => {
    const consistent = makePairState({
      pair_id: "q1",
      next_due: nowSeconds(),
      current_interval: 120,
      response_count: 4,
      pass_count: 3,
      fail_count: 1,
      timeout_count: 2,
    });
    expect(validatePairConsistency(consistent)).toBe(true);

    const inconsistent = makePairState({
      pair_id: "q2",
      next_due: nowSeconds(),
      current_interval: 120,
      response_count: 4,
      pass_count: 1,
      fail_count: 1,
    });
    expect(() => validatePairConsistency(inconsistent)).toThrow();
  });

  it("review event roundtrip", () => {
    const event = makeReviewEvent({
      pair_id: "q1",
      term: "Test",
      result: ReviewResult.PASS,
      elapsed_seconds: 5.5,
      timestamp: "2026-03-31T10:00:00",
      timeout_seconds: 30,
      user_answer: "apple",
    });
    const restored = reviewEventFromJSON(roundtrip(event) as Record<string, unknown>);
    expect(restored.pair_id).toBe("q1");
    expect(restored.result).toBe(ReviewResult.PASS);
    expect(restored.user_answer).toBe("apple");
  });

  it("pair state accepts legacy attempt_count", () => {
    const pair = pairStateFromJSON({
      pair_id: "q1",
      next_due: 100,
      current_interval: 120,
      attempt_count: 3,
      pass_count: 2,
      fail_count: 1,
      timeout_count: 1,
      answer_history: { apple: 2 },
    });
    expect(pair.response_count).toBe(3);
    expect(pair.pass_count).toBe(2);
    expect(pair.fail_count).toBe(1);
    expect(pair.timeout_count).toBe(1);
    expect(pair).not.toHaveProperty("attempt_count");
  });
});
