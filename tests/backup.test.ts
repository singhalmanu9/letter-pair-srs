import { describe, expect, it } from "vitest";
import { createDeck, loadApp } from "../src/app/bootstrap";
import { TEMPLATES } from "../src/data/templates";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  ImportError,
  applyDeckUpdate,
  applyImport,
  backupFileName,
  createBackup,
  createRawDump,
  deckUpdateHasChanges,
  parseImport,
  planDeckUpdate,
  planImport,
} from "../src/lib/backup";
import { KEYS, Repository } from "../src/lib/repository";
import { MemoryStore } from "../src/lib/storage";
import { config } from "./helpers";

const sample = TEMPLATES.find((t) => t.id === "sample")!;

/** A store with the sample deck and one passed review. */
async function seededRepo(): Promise<{ store: MemoryStore; repo: Repository; deckId: string }> {
  const store = new MemoryStore();
  const repo = new Repository(store);
  await createDeck(repo, sample, 1000);
  const result = await loadApp(repo, config, { now: 1000, onPersistError: (e) => { throw e; } });
  if (result.kind !== "ready") throw new Error("not ready");
  const { session, writes, deck } = result.app;
  const item = session.startNextReview(1000)!;
  session.revealAnswers(1001);
  session.gradePass(item.answers[0]!, 2000);
  await writes.idle();
  return { store, repo, deckId: deck.id };
}

async function importText(repo: Repository, text: string, policy: "replace" | "copy" | "skip" = "replace") {
  const plan = await planImport(repo, parseImport(text, "deck.json"), 5000);
  return { plan, result: await applyImport(repo, plan, policy, 5000) };
}

describe("export", () => {
  it("backs up every deck with progress and history", async () => {
    const { repo, deckId } = await seededRepo();
    const backup = await createBackup(repo, 9000);

    expect(backup).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 9000 });
    expect(backup.decks).toHaveLength(1);
    expect(backup.decks[0]!.deck.id).toBe(deckId);
    expect(backup.decks[0]!.progress.some((p) => p.stage === 1)).toBe(true);
    expect(backup.decks[0]!.history).toHaveLength(1);
  });

  it("names files by local date", () => {
    expect(backupFileName(new Date(2026, 10, 3).getTime())).toBe("letter-pairs-backup-2026-11-03.json");
    expect(backupFileName(new Date(2026, 10, 3).getTime(), "raw")).toBe("letter-pairs-raw-2026-11-03.json");
  });

  it("raw dump includes unreadable data verbatim", async () => {
    const { store, deckId } = await seededRepo();
    await store.set(KEYS.progress(deckId), "{broken");
    await store.set("unrelated", "x");

    const dump = await createRawDump(store, 1);
    expect(dump.entries[KEYS.progress(deckId)]).toBe("{broken");
    expect(dump.entries).not.toHaveProperty("unrelated");
  });
});

describe("import: backups", () => {
  it("restores a backup into empty storage exactly", async () => {
    const { repo } = await seededRepo();
    const backup = await createBackup(repo, 9000);

    const target = new Repository(new MemoryStore());
    const { result } = await importText(target, JSON.stringify(backup));

    const original = backup.decks[0]!;
    expect(result.imported).toEqual([original.deck.id]);
    expect(await target.getDeck(original.deck.id)).toEqual(original.deck);
    expect(await target.getProgress(original.deck.id)).toEqual(original.progress);
    expect(await target.getHistory(original.deck.id)).toEqual(original.history);
    expect((await target.getMeta()).activeDeckId).toBe(original.deck.id);
  });

  it("reports existing decks as conflicts without writing", async () => {
    const { repo, deckId } = await seededRepo();
    const text = JSON.stringify(await createBackup(repo, 9000));
    const before = await repo.getProgress(deckId);

    const plan = await planImport(repo, parseImport(text), 5000);
    expect(plan[0]!.existing?.id).toBe(deckId);
    expect(await repo.getProgress(deckId)).toEqual(before);
  });

  it("replace overwrites the existing deck's progress and history", async () => {
    const { repo, deckId } = await seededRepo();
    const backup = await createBackup(repo, 9000);
    await repo.saveProgress(deckId, (await repo.getProgress(deckId))!.map((p) => ({ ...p, stage: 7 })));
    await repo.replaceHistory(deckId, []);

    await importText(repo, JSON.stringify(backup), "replace");

    expect(await repo.getProgress(deckId)).toEqual(backup.decks[0]!.progress);
    expect(await repo.getHistory(deckId)).toHaveLength(1);
    expect(await repo.listDeckIds()).toEqual([deckId]);
  });

  it("skip leaves the existing deck alone", async () => {
    const { repo, deckId } = await seededRepo();
    const backup = await createBackup(repo, 9000);
    await repo.replaceHistory(deckId, []);

    const { result } = await importText(repo, JSON.stringify(backup), "skip");
    expect(result).toEqual({ imported: [], skipped: [deckId] });
    expect(await repo.getHistory(deckId)).toEqual([]);
  });

  it("copy imports under fresh ids, carrying progress and history across", async () => {
    const { repo, deckId } = await seededRepo();
    const backup = await createBackup(repo, 9000);

    const { result } = await importText(repo, JSON.stringify(backup), "copy");
    const copyId = result.imported[0]!;
    expect(copyId).not.toBe(deckId);

    const copy = (await repo.getDeck(copyId))!;
    const original = backup.decks[0]!;
    expect(copy.name).toBe(`${original.deck.name} (copy)`);
    expect(copy.items.map((i) => i.term)).toEqual(original.deck.items.map((i) => i.term));
    expect(copy.items.some((i) => original.deck.items.some((o) => o.id === i.id))).toBe(false);

    const copyProgress = (await repo.getProgress(copyId))!;
    expect(copyProgress.map((p) => p.pairId)).toEqual(copy.items.map((i) => i.id));
    expect(copyProgress.map((p) => p.stage)).toEqual(original.progress.map((p) => p.stage));
    const [event] = await repo.getHistory(copyId);
    expect(copy.items.map((i) => i.id)).toContain(event!.pairId);

    expect((await repo.getMeta()).activeDeckId).toBe(deckId); // active deck unchanged
  });

  it("syncs progress to the deck on import", async () => {
    const { repo } = await seededRepo();
    const backup = await createBackup(repo, 9000);
    const bundle = backup.decks[0]!;
    bundle.progress = bundle.progress.slice(1); // missing one pair
    bundle.progress.push({ ...bundle.progress[0]!, pairId: "orphan" });

    const target = new Repository(new MemoryStore());
    await importText(target, JSON.stringify(backup));
    const progress = (await target.getProgress(bundle.deck.id))!;
    expect(progress.map((p) => p.pairId)).toEqual(bundle.deck.items.map((i) => i.id));
  });

  it("rejects damaged backups and writes nothing", async () => {
    const { repo } = await seededRepo();
    const backup = await createBackup(repo, 9000);
    const good = backup.decks[0]!;
    const damaged = { ...backup, decks: [good, { ...good, deck: { ...good.deck, id: "second", items: "nope" } }] };

    const target = new Repository(new MemoryStore());
    expect(() => parseImport(JSON.stringify(damaged))).toThrow(ImportError);
    expect(() => parseImport(JSON.stringify(damaged))).toThrow(/decks\[1\]\.deck\.items/);
    expect(await target.listDeckIds()).toEqual([]);
  });

  it("rejects backups from a newer version", () => {
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, decks: [] });
    expect(() => parseImport(text)).toThrow(/newer version/);
  });
});

describe("import: deck lists", () => {
  it("imports the original Python app's deck.json as a new deck", async () => {
    const legacy = {
      version: "1.0",
      items: [
        { id: "term_001", term: "AC", answers: ["Andy Capp", "Awesome Coffee"] },
        { id: "term_002", term: "BD", answers: ["Big Deal"] },
      ],
    };
    const repo = new Repository(new MemoryStore());
    const { plan, result } = await importText(repo, JSON.stringify(legacy));

    expect(plan[0]!.existing).toBeNull();
    const deck = (await repo.getDeck(result.imported[0]!))!;
    expect(deck.name).toBe("deck");
    expect(deck.items.map((i) => [i.term, i.answers])).toEqual([
      ["AC", ["Andy Capp", "Awesome Coffee"]],
      ["BD", ["Big Deal"]],
    ]);
    expect(deck.items[0]!.id).not.toBe("term_001");
    expect((await repo.getProgress(deck.id))!.every((p) => p.stage === 0)).toBe(true);
  });

  it("uses the list's name, trims, and drops blank or duplicate answers", async () => {
    const list = { name: "My pairs", items: [{ term: " ab ", answers: ["Abbey", " Abbey ", "", 3, "Abs"] }] };
    const source = parseImport(JSON.stringify(list));
    expect(source).toMatchObject({
      kind: "deck-list",
      template: { name: "My pairs", items: [{ term: "ab", answers: ["Abbey", "Abs"] }] },
    });
  });

  it("importing the same list twice creates two independent decks", async () => {
    const repo = new Repository(new MemoryStore());
    const text = JSON.stringify({ items: [{ term: "AB", answers: ["Abbey"] }] });
    await importText(repo, text);
    await importText(repo, text);
    expect(await repo.listDeckIds()).toHaveLength(2);
  });

  it("gives readable errors for bad lists", async () => {
    const repo = new Repository(new MemoryStore());
    expect(() => parseImport("{nope")).toThrow("This file isn't valid JSON.");
    expect(() => parseImport("[]")).toThrow(/Unrecognized/);
    expect(() => parseImport(JSON.stringify({ hello: 1 }))).toThrow(/Unrecognized/);
    expect(() => parseImport(JSON.stringify({ items: [] }))).toThrow(/no items/);
    expect(() => parseImport(JSON.stringify({ items: [{ term: "AB", answers: [] }] }))).toThrow("AB has no answers.");
    expect(() => parseImport(JSON.stringify({ items: [{ answers: ["x"] }] }))).toThrow("Item 1 has no term.");

    const dupes = parseImport(JSON.stringify({ items: [{ term: "AB", answers: ["x"] }, { term: "ab", answers: ["y"] }] }));
    await expect(planImport(repo, dupes, 0)).rejects.toThrow(/Duplicate term/);
  });
});

describe("updating an existing deck from a deck list", () => {
  const listOf = (items: [string, string[]][]) => ({
    id: "import",
    name: "file",
    description: "",
    items: items.map(([term, answers]) => ({ term, answers })),
  });

  /** Sample deck with one reviewed pair (AC at Apprentice 1). */
  async function setup() {
    const seeded = await seededRepo();
    const deck = (await seeded.repo.getDeck(seeded.deckId))!;
    const ac = deck.items.find((i) => i.term === "AC")!;
    return { ...seeded, deck, ac };
  }

  const file = listOf([
    ["ac", ["Andy Capp", "Ace"]], // matched case-insensitively; loses 2 answers, gains "Ace"
    ["BD", ["Big Deal", "Bad Day", "Board"]], // unchanged
    ["CZ", ["Czech", "Crazy Zone", "Citizen Z"]], // same answers, different order
    ["ZZ", ["Zigzag"]], // new
  ]);

  it("plans additions, answer changes and missing pairs without writing", async () => {
    const { repo, deck, deckId } = await setup();
    const before = JSON.stringify(await repo.getDeck(deckId));

    const plan = planDeckUpdate(deck, file);
    expect(plan).toEqual({
      deckId,
      deckName: "Sample deck",
      addedTerms: ["ZZ"],
      missingTerms: ["DF", "EG"],
      changed: [{ term: "AC", added: ["Ace"], removed: ["Andy Cappuccino", "Awesome Coffee"] }],
      unchangedCount: 2,
    });
    expect(JSON.stringify(await repo.getDeck(deckId))).toBe(before);
  });

  it("applies the file's answers, adds new pairs, keeps missing pairs, and keeps progress", async () => {
    const { repo, deckId, ac } = await setup();
    const acProgressBefore = (await repo.getProgress(deckId))!.find((p) => p.pairId === ac.id)!;

    const updated = await applyDeckUpdate(repo, deckId, file, { removeMissing: false }, 7000);

    expect(updated.items.map((i) => i.term)).toEqual(["AC", "BD", "CZ", "DF", "EG", "ZZ"]);
    const newAc = updated.items.find((i) => i.term === "AC")!;
    expect(newAc).toMatchObject({ id: ac.id, answers: ["Andy Capp", "Ace"], updatedAt: 7000 });
    expect(updated.items.find((i) => i.term === "CZ")!.answers).toEqual(["Czech", "Crazy Zone", "Citizen Z"]);
    expect(updated.items.find((i) => i.term === "BD")!.updatedAt).toBe(1000);

    const progress = (await repo.getProgress(deckId))!;
    expect(progress.find((p) => p.pairId === ac.id)).toEqual(acProgressBefore);
    expect(progress.find((p) => p.pairId === updated.items.at(-1)!.id)).toMatchObject({ stage: 0 });
    expect(progress.map((p) => p.pairId)).toEqual(updated.items.map((i) => i.id));
    expect(await repo.getHistory(deckId)).toHaveLength(1);
  });

  it("removes missing pairs and their progress when asked", async () => {
    const { repo, deckId } = await setup();
    const updated = await applyDeckUpdate(repo, deckId, file, { removeMissing: true }, 7000);

    expect(updated.items.map((i) => i.term)).toEqual(["AC", "BD", "CZ", "ZZ"]);
    expect((await repo.getProgress(deckId))!.map((p) => p.pairId)).toEqual(updated.items.map((i) => i.id));
  });

  it("detects when nothing would change", async () => {
    const { deck } = await setup();
    const same = listOf(deck.items.map((i) => [i.term, i.answers]));
    const plan = planDeckUpdate(deck, same);
    expect(deckUpdateHasChanges(plan, { removeMissing: true })).toBe(false);

    const subset = listOf(deck.items.slice(1).map((i) => [i.term, i.answers]));
    const subsetPlan = planDeckUpdate(deck, subset);
    expect(deckUpdateHasChanges(subsetPlan, { removeMissing: false })).toBe(false);
    expect(deckUpdateHasChanges(subsetPlan, { removeMissing: true })).toBe(true);
  });

  it("rejects files that list a pair twice", async () => {
    const { deck } = await setup();
    expect(() => planDeckUpdate(deck, listOf([["AB", ["x"]], ["ab", ["y"]]]))).toThrow(/more than once/);
  });

  it("the updated deck loads and reviews normally", async () => {
    const { store, repo, deckId } = await setup();
    await applyDeckUpdate(repo, deckId, file, { removeMissing: true }, 7000);
    const result = await loadApp(new Repository(store), config, { now: 8000, onPersistError: () => {} });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.app.engine.pairs).toHaveLength(4);
  });
});
