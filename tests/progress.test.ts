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

  it("sync does not mutate its input", () => {
    const input = [makePair("gone")];
    syncProgress(makeDeck([["q1", "AC"]]), input, 0);
    expect(input).toHaveLength(1);
  });
});
