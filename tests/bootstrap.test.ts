import { beforeEach, describe, expect, it } from "vitest";
import { createDeck, loadApp, WriteQueue, type AppContext, type LoadResult } from "../src/app/bootstrap";
import { TEMPLATES } from "../src/data/templates";
import { KEYS, Repository } from "../src/lib/repository";
import { ReviewResult } from "../src/lib/schemas";
import { MemoryStore } from "../src/lib/storage";
import { EMPTY_TEMPLATE } from "../src/lib/templates";
import { config } from "./helpers";

const sample = TEMPLATES.find((t) => t.id === "sample")!;

describe("bootstrap", () => {
  let store: MemoryStore;
  let errors: unknown[];

  /** Load the app as a fresh page load would, against the same store. */
  const load = (now = 1000): Promise<LoadResult> =>
    loadApp(new Repository(store), config, { now, onPersistError: (e) => errors.push(e) });
  const ready = async (now = 1000): Promise<AppContext> => {
    const result = await load(now);
    if (result.kind !== "ready") throw new Error(`expected ready, got ${result.kind}`);
    return result.app;
  };

  beforeEach(() => {
    store = new MemoryStore();
    errors = [];
  });

  it("asks for a deck on first run", async () => {
    expect((await load()).kind).toBe("no-deck");
  });

  it("creates an independent deck from a template", async () => {
    const deck = await createDeck(new Repository(store), sample, 1000);
    expect(deck.templateId).toBe("sample");
    expect(deck.items.map((i) => i.term)).toEqual(sample.items.map((i) => i.term));
    expect(new Set(deck.items.map((i) => i.id)).size).toBe(sample.items.length);

    deck.items[0]!.answers.push("changed");
    expect(sample.items[0]!.answers).not.toContain("changed");
  });

  it("an empty deck loads with nothing due", async () => {
    await createDeck(new Repository(store), EMPTY_TEMPLATE, 1000);
    const app = await ready();
    expect(app.deck.items).toEqual([]);
    expect(app.session.startNextReview(1000)).toBeNull();
  });

  it("first load creates progress with every pair new and due", async () => {
    await createDeck(new Repository(store), sample, 1000);
    const app = await ready();
    expect(app.engine.dueCount(1000)).toBe(sample.items.length);
    expect(await app.repo.getProgress(app.deck.id)).toHaveLength(sample.items.length);
  });

  it("reviews survive a reload", async () => {
    await createDeck(new Repository(store), sample, 1000);
    const app = await ready();
    const item = app.session.startNextReview(1000)!;
    app.session.revealAnswers(1001);
    app.session.gradePass(item.answers[0]!, 2000);
    await app.writes.idle();

    const reloaded = await ready(3000);
    const pair = reloaded.engine.pairs.find((p) => p.pairId === item.id)!;
    expect(pair).toMatchObject({ stage: 1, passCount: 1 });
    expect(await reloaded.repo.getHistory(reloaded.deck.id)).toMatchObject([{ pairId: item.id, result: ReviewResult.PASS }]);
    expect(errors).toEqual([]);
  });

  it("an in-progress review resumes after reload, with a fresh timer", async () => {
    await createDeck(new Repository(store), sample, 1000);
    const app = await ready();
    const item = app.session.startNextReview(1000)!;
    app.session.revealAnswers(1500);
    await app.writes.idle();

    const reloaded = await ready(900_000);
    expect(reloaded.session.activeReview).toMatchObject({ pairId: item.id, revealedAt: 900_000 });
    expect(reloaded.session.timeRemaining(900_000)).toBe(config.timer.staticMs);
  });

  it("syncs progress when pairs are added to or removed from the deck", async () => {
    const repo = new Repository(store);
    const deck = await createDeck(repo, sample, 1000);
    const removed = deck.items.shift()!;
    deck.items.push({ id: "new-pair", term: "ZZ", answers: ["Zigzag"], updatedAt: 2000 });
    await repo.saveDeck(deck);

    const app = await ready(5000);
    const ids = app.engine.pairs.map((p) => p.pairId);
    expect(ids).toContain("new-pair");
    expect(ids).not.toContain(removed.id);
    expect(app.engine.pairs.find((p) => p.pairId === "new-pair")).toMatchObject({ stage: 0, nextDueAt: 5000 });
    expect((await repo.getProgress(deck.id))?.map((p) => p.pairId)).toEqual(ids);
  });

  it("a pair whose answers were all removed comes back as New on load", async () => {
    const repo = new Repository(store);
    const deck = await createDeck(repo, sample, 1000);
    const app = await ready();
    const item = app.session.startNextReview(1000)!;
    app.session.revealAnswers(1001);
    app.session.gradePass(null, 1002);
    await app.writes.idle();

    deck.items.find((i) => i.id === item.id)!.answers = [];
    await repo.saveDeck(deck);

    const reloaded = await ready(5000);
    expect(reloaded.engine.pairs.find((p) => p.pairId === item.id)).toMatchObject({ stage: 0, nextDueAt: 5000 });
    expect((await repo.getProgress(deck.id))!.find((p) => p.pairId === item.id)!.stage).toBe(0);
  });

  it("an answer typed for an unanswered pair is saved to the deck", async () => {
    const repo = new Repository(store);
    const deck = await createDeck(repo, sample, 1000);
    deck.items.push({ id: "blank", term: "ZZ", answers: [], updatedAt: 1000 });
    await repo.saveDeck(deck);

    const app = await ready(1000);
    app.session.restoreActiveReview({ deckId: deck.id, pairId: "blank", startedAt: 1000, revealed: false }, 1000);
    app.session.submitNewAnswer("Zigzag", 2000);
    await app.writes.idle();

    expect((await repo.getDeck(deck.id))!.items.find((i) => i.id === "blank")!.answers).toEqual(["Zigzag"]);
    expect(errors).toEqual([]);
  });

  it("discards a saved review whose pair was deleted", async () => {
    const repo = new Repository(store);
    const deck = await createDeck(repo, sample, 1000);
    await repo.saveActiveReview({ deckId: deck.id, pairId: "deleted", startedAt: 0, revealed: false });

    const app = await ready();
    expect(app.session.activeReview).toBeNull();
    expect(await repo.getActiveReview()).toBeNull();
  });

  it("falls back to the first deck if the active deck pointer is stale", async () => {
    const repo = new Repository(store);
    const deck = await createDeck(repo, sample, 1000);
    await repo.setActiveDeck("gone");
    expect((await ready()).deck.id).toBe(deck.id);
  });

  it("reports corrupt data instead of overwriting it", async () => {
    const repo = new Repository(store);
    const deck = await createDeck(repo, sample, 1000);
    await store.set(KEYS.progress(deck.id), "garbage");

    const result = await load();
    expect(result).toMatchObject({ kind: "error", key: KEYS.progress(deck.id) });
    expect(await store.get(KEYS.progress(deck.id))).toBe("garbage");
  });
});

describe("WriteQueue", () => {
  it("runs writes in order and keeps going after a failure", async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    const queue = new WriteQueue((e) => errors.push(e));
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    queue.enqueue(async () => {
      await delay(10);
      order.push("slow");
    });
    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(async () => {
      order.push("fast");
    });
    await queue.idle();

    expect(order).toEqual(["slow", "fast"]);
    expect(errors).toHaveLength(1);
  });
});
