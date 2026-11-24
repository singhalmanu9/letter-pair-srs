import { describe, expect, it } from "vitest";
import { newPairState, syncProgress } from "../src/lib/progress";
import { makeDeck, makePair } from "./helpers";

describe("progress", () => {
  it("new pair state is new and due now", () => {
    expect(newPairState("q1", 500)).toMatchObject({ pairId: "q1", stage: 0, nextDueAt: 500, responseCount: 0 });
  });

  it("sync adds state for new deck items", () => {
    const deck = makeDeck([["q1", "AC"], ["q2", "BD"]]);
    const existing = makePair("q1", { stage: 4 });
    const { pairs, added, removed } = syncProgress(deck, [existing], 999);

    expect(added).toEqual(["q2"]);
    expect(removed).toEqual([]);
    expect(pairs[0]).toBe(existing);
    expect(pairs[1]).toMatchObject({ pairId: "q2", stage: 0, nextDueAt: 999 });
  });

  it("sync drops state for removed deck items and follows deck order", () => {
    const deck = makeDeck([["q2", "BD"], ["q1", "AC"]]);
    const { pairs, added, removed } = syncProgress(deck, [makePair("q1"), makePair("gone"), makePair("q2")], 0);
    expect(pairs.map((p) => p.pairId)).toEqual(["q2", "q1"]);
    expect(added).toEqual([]);
    expect(removed).toEqual(["gone"]);
  });

  it("sync resets pairs with no answers to New and due", () => {
    const deck = makeDeck([["q1", "AC", []], ["q2", "BD"]]);
    const stuck = makePair("q1", { stage: 6, nextDueAt: 9_999_999, passCount: 5, responseCount: 5 });
    const fine = makePair("q2", { stage: 6, nextDueAt: 9_999_999 });
    const { pairs, reset } = syncProgress(deck, [stuck, fine], 1000);

    expect(reset).toEqual(["q1"]);
    expect(pairs[0]).toMatchObject({ stage: 0, nextDueAt: 1000, passCount: 5 });
    expect(pairs[1]).toBe(fine);
    expect(stuck.stage).toBe(6); // input untouched
  });

  it("sync leaves an unanswered pair that is already New and due alone", () => {
    const pair = makePair("q1", { nextDueAt: 500 });
    const { pairs, reset } = syncProgress(makeDeck([["q1", "AC", []]]), [pair], 1000);
    expect(reset).toEqual([]);
    expect(pairs[0]).toBe(pair);
  });

  it("sync does not mutate its input", () => {
    const input = [makePair("gone")];
    syncProgress(makeDeck([["q1", "AC"]]), input, 0);
    expect(input).toHaveLength(1);
  });
});
