import { describe, expect, it } from "vitest";
import {
  ReviewResult,
  ValidationError,
  addAnswerToPair,
  getItemById,
  hasAnswers,
  mostCommonAnswer,
  parseActiveReviewSnapshot,
  parseDeck,
  parsePairState,
  parseReviewEvent,
  recordAnswer,
  removeAnswerFromPair,
  totalResponses,
  validateDeck,
  validatePairConsistency,
  type ReviewEvent,
} from "../src/lib/schemas";
import { makeDeck, makePair } from "./helpers";

/** Simulate a save/load cycle. */
const roundtrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("parsing", () => {
  it("deck roundtrip", () => {
    const deck = makeDeck([["q1", "AC", ["apple", "APPLE"]], ["q2", "BD"]]);
    expect(parseDeck(roundtrip(deck))).toEqual(deck);
  });

  it("an empty deck is valid", () => {
    expect(parseDeck(roundtrip(makeDeck([]))).items).toEqual([]);
  });

  it("validateDeck rejects blank terms and answers", () => {
    expect(() => validateDeck(makeDeck([["q1", "  ", ["x"]]]))).toThrow(/Blank term/);
    expect(() => validateDeck(makeDeck([["q1", "AC", ["ok", " "]]]))).toThrow(/Blank answer/);
  });

  it("allows pairs with no answers yet", () => {
    expect(parseDeck(roundtrip(makeDeck([["q1", "AC", []]]))).items[0]!.answers).toEqual([]);
  });

  it("rejects decks with missing fields, blank answers or duplicate terms", () => {
    const deck = makeDeck([["q1", "AC"]]) as unknown as Record<string, unknown>;
    expect(() => parseDeck({ ...deck, name: undefined })).toThrow(/deck\.name/);
    expect(() => parseDeck(roundtrip(makeDeck([["q1", "AC", ["  "]]])))).toThrow(/must not be empty/);
    expect(() => parseDeck(roundtrip(makeDeck([["q1", "AC"], ["q2", "ac"]])))).toThrow(/Duplicate term/);
    expect(() => parseDeck(roundtrip(makeDeck([["q1", "AC"], ["q1", "BD"]])))).toThrow(/Duplicate item id/);
  });

  it("pair state roundtrip", () => {
    const pair = makePair("q1", {
      stage: 3,
      nextDueAt: 123_456,
      responseCount: 7,
      passCount: 5,
      failCount: 2,
      timeoutCount: 3,
      answerHistory: { apple: 3, pomme: 1 },
    });
    const restored = parsePairState(roundtrip(pair));
    expect(restored).toEqual(pair);
    expect(totalResponses(restored)).toBe(10);
  });

  it("burned pairs store a null due time", () => {
    expect(parsePairState(roundtrip(makePair("q1", { stage: 9, nextDueAt: null }))).nextDueAt).toBeNull();
  });

  it("rejects inconsistent or malformed pair state", () => {
    expect(() => parsePairState(roundtrip(makePair("q1", { responseCount: 4, passCount: 1, failCount: 1 })))).toThrow(
      ValidationError,
    );
    expect(() => parsePairState({ ...makePair("q1"), stage: -1 })).toThrow(/stage/);
    expect(() => parsePairState({ ...makePair("q1"), answerHistory: { a: "lots" } })).toThrow(/answerHistory/);
  });

  it("review event roundtrip and invalid result", () => {
    const event: ReviewEvent = {
      pairId: "q1",
      term: "AC",
      result: ReviewResult.PASS,
      stageBefore: 1,
      stageAfter: 2,
      elapsedMs: 5500,
      timeoutMs: 30_000,
      reviewedAt: 1000,
      userAnswer: "apple",
      reason: null,
    };
    expect(parseReviewEvent(roundtrip(event))).toEqual(event);
    expect(() => parseReviewEvent({ ...event, result: "maybe" })).toThrow(/result/);
  });

  it("active review snapshot requires all fields", () => {
    const snap = { deckId: "d", pairId: "q1", startedAt: 5, revealed: false };
    expect(parseActiveReviewSnapshot(roundtrip(snap))).toEqual(snap);
    expect(() => parseActiveReviewSnapshot({ pairId: "q1" })).toThrow();
  });
});

describe("deck helpers", () => {
  it("get item by id", () => {
    const deck = makeDeck([["q1", "A"], ["q2", "B"]]);
    expect(getItemById(deck, "q1")?.term).toBe("A");
    expect(getItemById(deck, "q999")).toBeUndefined();
  });

  it("add answer trims, ignores duplicates and blanks, and bumps updatedAt", () => {
    const deck = makeDeck([["q1", "Apple", ["apple"]]]);
    expect(addAnswerToPair(deck, "q1", "  pomme ", 50)).toBe(true);
    expect(deck.items[0]!.answers).toEqual(["apple", "pomme"]);
    expect(deck.items[0]!.updatedAt).toBe(50);
    expect(deck.updatedAt).toBe(50);

    expect(addAnswerToPair(deck, "q1", "pomme", 60)).toBe(false);
    expect(addAnswerToPair(deck, "q1", "   ", 60)).toBe(false);
    expect(addAnswerToPair(deck, "nope", "x", 60)).toBe(false);
    expect(deck.updatedAt).toBe(50);
  });
});

describe("removing answers", () => {
  it("removes an answer and bumps updatedAt", () => {
    const deck = makeDeck([["q1", "AC", ["Andy Capp", "Ace"]]]);
    expect(removeAnswerFromPair(deck, "q1", "Ace", 70)).toBe(true);
    expect(deck.items[0]!.answers).toEqual(["Andy Capp"]);
    expect(deck.items[0]!.updatedAt).toBe(70);
    expect(deck.updatedAt).toBe(70);
  });

  it("can remove the last answer, leaving the pair unanswered", () => {
    const deck = makeDeck([["q1", "AC", ["Andy Capp"]]]);
    expect(removeAnswerFromPair(deck, "q1", "Andy Capp", 70)).toBe(true);
    expect(hasAnswers(deck.items[0]!)).toBe(false);
  });

  it("ignores a missing answer or a missing pair", () => {
    const deck = makeDeck([["q1", "AC", ["Andy Capp"]]]);
    expect(removeAnswerFromPair(deck, "q1", "nope", 70)).toBe(false);
    expect(removeAnswerFromPair(deck, "zz", "Andy Capp", 70)).toBe(false);
    expect(deck.items[0]!.answers).toEqual(["Andy Capp"]);
    expect(deck.updatedAt).toBe(0);
  });
});

describe("pair state helpers", () => {
  it("tracks answer history and the most common answer", () => {
    const pair = makePair("q1");
    for (const answer of ["apple", "pomme", "apple", "apple"]) recordAnswer(pair, answer);
    expect(pair.answerHistory).toEqual({ apple: 3, pomme: 1 });
    expect(mostCommonAnswer(pair)).toBe("apple");
    expect(mostCommonAnswer(makePair("q2"))).toBeNull();
  });

  it("consistency validation", () => {
    expect(validatePairConsistency(makePair("q1", { responseCount: 4, passCount: 3, failCount: 1 }))).toBe(true);
  });
});
