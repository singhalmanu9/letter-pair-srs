import { beforeEach, describe, expect, it } from "vitest";
import { CorruptDataError, KEYS, NewerSchemaError, Repository, SCHEMA_VERSION } from "../src/lib/repository";
import { ReviewResult, type ReviewEvent } from "../src/lib/schemas";
import { MemoryStore } from "../src/lib/storage";
import { makeDeck, makePair } from "./helpers";

const event = (pairId: string): ReviewEvent => ({
  pairId,
  term: "AC",
  result: ReviewResult.PASS,
  stageBefore: 0,
  stageAfter: 1,
  elapsedMs: 1,
  timeoutMs: 30_000,
  reviewedAt: 1,
  userAnswer: null,
  reason: null,
});

describe("Repository", () => {
  let store: MemoryStore;
  let repo: Repository;

  beforeEach(async () => {
    store = new MemoryStore();
    repo = new Repository(store);
    await repo.init();
  });

  it("creates metadata on first init and keeps it on later inits", async () => {
    expect(await repo.getMeta()).toEqual({ schemaVersion: SCHEMA_VERSION, activeDeckId: null });
    await repo.setActiveDeck("abc");
    expect(await new Repository(store).init()).toEqual({ schemaVersion: SCHEMA_VERSION, activeDeckId: "abc" });
  });

  it("refuses data from a newer app version", async () => {
    await store.set(KEYS.meta, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, activeDeckId: null }));
    await expect(new Repository(store).init()).rejects.toBeInstanceOf(NewerSchemaError);
  });

  it("saves, lists and loads decks", async () => {
    const a = makeDeck([["q1", "AC"]], "a");
    const b = makeDeck([], "b");
    await repo.saveDeck(a);
    await repo.saveDeck(b);
    await repo.saveDeck(a); // re-saving doesn't duplicate the index entry

    expect(await repo.listDeckIds()).toEqual(["a", "b"]);
    expect(await repo.getDeck("a")).toEqual(a);
    expect((await repo.listDecks()).map((d) => d.id)).toEqual(["a", "b"]);
    expect(await repo.getDeck("missing")).toBeNull();
  });

  it("validates decks before saving", async () => {
    await expect(repo.saveDeck(makeDeck([["q1", "AC"], ["q2", "AC"]]))).rejects.toThrow(/Duplicate term/);
    expect(await repo.listDeckIds()).toEqual([]);
  });

  it("progress and history roundtrip", async () => {
    expect(await repo.getProgress("a")).toBeNull();
    const pairs = [makePair("q1", { stage: 3, nextDueAt: 99 })];
    await repo.saveProgress("a", pairs);
    expect(await repo.getProgress("a")).toEqual(pairs);

    expect(await repo.getHistory("a")).toEqual([]);
    await repo.appendEvent("a", event("q1"));
    await repo.appendEvent("a", event("q2"));
    expect((await repo.getHistory("a")).map((e) => e.pairId)).toEqual(["q1", "q2"]);
  });

  it("active review save, load and clear", async () => {
    const snap = { deckId: "a", pairId: "q1", startedAt: 5, revealed: false };
    await repo.saveActiveReview(snap);
    expect(await repo.getActiveReview()).toEqual(snap);
    await repo.clearActiveReview();
    expect(await repo.getActiveReview()).toBeNull();
  });

  it("deleting a deck removes its progress, history, active review and active-deck pointer", async () => {
    await repo.saveDeck(makeDeck([["q1", "AC"]], "a"));
    await repo.saveDeck(makeDeck([], "b"));
    await repo.saveProgress("a", [makePair("q1")]);
    await repo.appendEvent("a", event("q1"));
    await repo.saveActiveReview({ deckId: "a", pairId: "q1", startedAt: 0, revealed: false });
    await repo.setActiveDeck("a");

    await repo.deleteDeck("a");

    expect(await repo.listDeckIds()).toEqual(["b"]);
    expect(await repo.getDeck("a")).toBeNull();
    expect(await repo.getProgress("a")).toBeNull();
    expect(await repo.getHistory("a")).toEqual([]);
    expect(await repo.getActiveReview()).toBeNull();
    expect((await repo.getMeta()).activeDeckId).toBeNull();
  });

  it("reports unparseable JSON as corrupt, naming the key", async () => {
    await store.set(KEYS.progress("a"), "{not json");
    const error = await repo.getProgress("a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorruptDataError);
    expect((error as CorruptDataError).key).toBe(KEYS.progress("a"));
  });

  it("reports structurally invalid data as corrupt and leaves it untouched", async () => {
    const bad = JSON.stringify([{ pairId: "q1", stage: "high" }]);
    await store.set(KEYS.progress("a"), bad);
    await expect(repo.getProgress("a")).rejects.toBeInstanceOf(CorruptDataError);
    expect(await store.get(KEYS.progress("a"))).toBe(bad);
  });

  it("resetAll removes only this app's keys", async () => {
    await repo.saveDeck(makeDeck([], "a"));
    await store.set("someone-else", "keep me");
    await repo.resetAll();
    expect(await store.keys("lpsrs:")).toEqual([]);
    expect(await store.get("someone-else")).toBe("keep me");
  });
});
