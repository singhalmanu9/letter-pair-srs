import { beforeEach, describe, expect, it } from "vitest";
import { nowSeconds } from "../src/lib/config";
import {
  MemoryStore,
  appendReviewEvent,
  clearSessionSnapshot,
  initializeStateForDeck,
  loadDeck,
  loadHistory,
  loadSessionSnapshot,
  loadState,
  saveDeck,
  saveSessionSnapshot,
  saveState,
} from "../src/lib/persistence";
import {
  ReviewResult,
  addAnswerToPair,
  getItemById,
  makePairState,
  makeReviewEvent,
  validateState,
  type Deck,
  type SRSState,
} from "../src/lib/schemas";

const deck = (...items: [string, string, string[]][]): Deck => ({
  version: "1.0",
  items: items.map(([id, term, answers]) => ({ id, term, answers })),
});

describe("persistence", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("deck roundtrip", () => {
    saveDeck(store, deck(["q1", "A", ["answer1", "answer2"]], ["q2", "B", ["answer3"]]));
    const loaded = loadDeck(store);
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[0]?.id).toBe("q1");
    expect(loaded.items[0]?.answers).toEqual(["answer1", "answer2"]);
  });

  it("deck add answer and persist", () => {
    saveDeck(store, deck(["q1", "Apple", ["apple"]]));
    const loaded = loadDeck(store);
    expect(addAnswerToPair(loaded, "q1", "pomme")).toBe(true);
    saveDeck(store, loaded);

    const item = getItemById(loadDeck(store), "q1");
    expect(item).toBeDefined();
    expect(item?.answers).toContain("pomme");
  });

  it("deck get item by id", () => {
    const d = deck(["q1", "A", ["a"]], ["q2", "B", ["b"]]);
    expect(getItemById(d, "q1")?.term).toBe("A");
    expect(getItemById(d, "q999")).toBeUndefined();
  });

  it("state roundtrip", () => {
    const state: SRSState = {
      version: "1.0",
      pairs: [
        makePairState({
          pair_id: "q1",
          next_due: nowSeconds(),
          current_interval: 60,
          response_count: 1,
          pass_count: 1,
          fail_count: 0,
          timeout_count: 2,
          answer_history: { a: 1 },
        }),
        makePairState({
          pair_id: "q2",
          next_due: nowSeconds() + 120,
          current_interval: 90,
          response_count: 4,
          pass_count: 2,
          fail_count: 2,
          timeout_count: 1,
          answer_history: { b: 2, bee: 1 },
        }),
      ],
    };
    const d = deck(["q1", "A", ["a"]], ["q2", "B", ["b"]]);

    saveState(store, state);
    const loaded = loadState(store, d);
    expect(loaded.pairs).toEqual(state.pairs);
    expect(validateState(d, loaded)).toBe(true);
  });

  it("history append", () => {
    appendReviewEvent(
      store,
      makeReviewEvent({
        pair_id: "q1",
        term: "A",
        result: ReviewResult.PASS,
        elapsed_seconds: 5.5,
        timestamp: "2026-01-01T10:00:00",
        timeout_seconds: 30,
      }),
    );
    appendReviewEvent(
      store,
      makeReviewEvent({
        pair_id: "q2",
        term: "B",
        result: ReviewResult.TIMEOUT,
        elapsed_seconds: 30,
        timestamp: "2026-01-01T10:01:00",
        timeout_seconds: 30,
        reason: "timeout",
      }),
    );

    const events = loadHistory(store);
    expect(events).toHaveLength(2);
    expect(events[0]?.pair_id).toBe("q1");
    expect(events[0]?.result).toBe(ReviewResult.PASS);
    expect(events[1]?.reason).toBe("timeout");
  });

  it("initialize state", () => {
    const state = initializeStateForDeck(deck(["q1", "A", ["a"]], ["q2", "B", ["b"]], ["q3", "C", ["c"]]), 60);
    expect(state.pairs).toHaveLength(3);
    expect(state.pairs.every((p) => p.response_count === 0)).toBe(true);
    expect(state.pairs.every((p) => p.current_interval === 60)).toBe(true);
  });

  it("save, load and clear session snapshot", () => {
    const snapshot = {
      pair_id: "q1",
      term: "AC",
      answers: ["apple"],
      started_at: 123,
      timeout_seconds: 30,
      revealed: false,
    };
    saveSessionSnapshot(store, snapshot);
    expect(loadSessionSnapshot(store)).toEqual(snapshot);

    clearSessionSnapshot(store);
    expect(loadSessionSnapshot(store)).toBeNull();
  });
});
