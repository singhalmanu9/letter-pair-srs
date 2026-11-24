/**
 * JSON export/import.
 *
 * Two kinds of file are accepted:
 * - Backup: every deck with its progress and review history, as exported
 *   by this app. Restores exactly.
 * - Deck list: `{ name?, items: [{ term, answers? }] }`. This also covers the
 *   original Python app's deck.json. Becomes a new deck with fresh progress.
 *   Items may have no answers yet.
 *
 * Importing is two-phase: `planImport` validates everything and reports
 * conflicts without writing; `applyImport` then writes. A file that fails
 * validation writes nothing.
 *
 * A deck list can instead update an existing deck (`planDeckUpdate` /
 * `applyDeckUpdate`): pairs are matched by term, the file's answers win,
 * and progress is kept.
 */

import { syncProgress } from "./progress";
import { STORAGE_PREFIX, type Repository } from "./repository";
import type { AsyncKeyValueStore } from "./storage";
import {
  ValidationError,
  termKey,
  parseDeck,
  parseHistory,
  parseProgress,
  type Deck,
  type PairState,
  type ReviewEvent,
} from "./schemas";
import { createDeckFromTemplate, type DeckTemplate } from "./templates";

export const BACKUP_FORMAT = "letter-pair-srs-backup";
export const BACKUP_VERSION = 1;

export interface DeckBundle {
  deck: Deck;
  progress: PairState[];
  history: ReviewEvent[];
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  decks: DeckBundle[];
}

/** User-facing import failure. The message is safe to show as-is. */
export class ImportError extends Error {
  override name = "ImportError";
}

// ---------------------------------------------------------------------------
// Export

/** Build a backup of the given decks (default: all decks). */
export async function createBackup(repo: Repository, now: number, deckIds?: string[]): Promise<Backup> {
  const ids = deckIds ?? (await repo.listDeckIds());
  const decks: DeckBundle[] = [];
  for (const id of ids) {
    const deck = await repo.getDeck(id);
    if (!deck) continue;
    decks.push({ deck, progress: (await repo.getProgress(id)) ?? [], history: await repo.getHistory(id) });
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now, decks };
}

/**
 * Every stored value for this app, as raw unparsed strings. For rescuing data
 * when a normal backup fails because something stored is unreadable.
 */
export async function createRawDump(
  store: AsyncKeyValueStore,
  now: number,
): Promise<{ format: string; exportedAt: number; entries: Record<string, string> }> {
  const entries: Record<string, string> = {};
  for (const key of (await store.keys(STORAGE_PREFIX)).sort()) {
    const value = await store.get(key);
    if (value !== null) entries[key] = value;
  }
  return { format: "letter-pair-srs-raw", exportedAt: now, entries };
}

/** e.g. "letter-pairs-backup-2026-11-23.json" (local date). */
export function backupFileName(now: number, kind = "backup"): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `letter-pairs-${kind}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

// ---------------------------------------------------------------------------
// Import: parsing

export type ImportSource =
  | { kind: "backup"; bundles: DeckBundle[] }
  | { kind: "deck-list"; template: DeckTemplate };

/** Parse an import file's text. Throws ImportError with a readable message. */
export function parseImport(text: string, fileName?: string): ImportSource {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError("This file isn't valid JSON.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ImportError("Unrecognized file: expected a backup or a deck list.");
  }
  const o = data as Record<string, unknown>;

  if (o.format === BACKUP_FORMAT) return { kind: "backup", bundles: parseBackupBundles(o) };
  if (Array.isArray(o.items)) return { kind: "deck-list", template: parseDeckList(o, fileName) };
  throw new ImportError("Unrecognized file: expected a backup or a deck list.");
}

function parseBackupBundles(o: Record<string, unknown>): DeckBundle[] {
  if (typeof o.version !== "number") throw new ImportError("Backup is missing its version number.");
  if (o.version > BACKUP_VERSION) {
    throw new ImportError("This backup was made by a newer version of the app. Update the app and try again.");
  }
  if (!Array.isArray(o.decks)) throw new ImportError("Backup has no decks list.");

  const seen = new Set<string>();
  return o.decks.map((raw, i) => {
    const path = `decks[${i}]`;
    try {
      const b = raw as Record<string, unknown>;
      const deck = parseDeck(b?.deck, `${path}.deck`);
      if (seen.has(deck.id)) throw new ValidationError(`${path}: duplicate deck id ${deck.id}`);
      seen.add(deck.id);
      return {
        deck,
        progress: parseProgress(b.progress ?? [], `${path}.progress`),
        history: parseHistory(b.history ?? [], `${path}.history`),
      };
    } catch (error) {
      throw new ImportError(`Backup is damaged (${error instanceof Error ? error.message : String(error)}).`);
    }
  });
}

function parseDeckList(o: Record<string, unknown>, fileName?: string): DeckTemplate {
  const items = (o.items as unknown[]).map((raw, i) => {
    const row = `Item ${i + 1}`;
    if (typeof raw !== "object" || raw === null) throw new ImportError(`${row} isn't an object.`);
    const r = raw as Record<string, unknown>;
    if (typeof r.term !== "string" || r.term.trim() === "") throw new ImportError(`${row} has no term.`);
    const term = r.term.trim();
    // Answers are optional: pairs without any start as New with no answers.
    if (r.answers !== undefined && !Array.isArray(r.answers)) throw new ImportError(`${term}: answers must be a list.`);
    const given: unknown[] = Array.isArray(r.answers) ? r.answers : [];
    const answers = [...new Set(given.filter((a): a is string => typeof a === "string").map((a) => a.trim()))].filter(
      (a) => a !== "",
    );
    return { term, answers };
  });
  if (items.length === 0) throw new ImportError("This deck list has no items.");

  const name =
    (typeof o.name === "string" && o.name.trim()) ||
    fileName?.replace(/\.[^.]+$/, "").trim() ||
    "Imported deck";
  return { id: "import", name, description: "", items };
}

// ---------------------------------------------------------------------------
// Import: planning and applying

export interface ImportPlanEntry {
  bundle: DeckBundle;
  /** The stored deck with the same id, if any. Only backups can conflict. */
  existing: Deck | null;
}

/** What to do with a deck that already exists. */
export type ConflictPolicy = "replace" | "copy" | "skip";

/** Validate against current storage and report conflicts. Writes nothing. */
export async function planImport(repo: Repository, source: ImportSource, now: number): Promise<ImportPlanEntry[]> {
  if (source.kind === "deck-list") {
    let deck: Deck;
    try {
      deck = createDeckFromTemplate(source.template, now);
    } catch (error) {
      throw new ImportError(error instanceof Error ? error.message : String(error));
    }
    return [{ bundle: { deck, progress: [], history: [] }, existing: null }];
  }

  const entries: ImportPlanEntry[] = [];
  for (const bundle of source.bundles) {
    entries.push({ bundle, existing: await repo.getDeck(bundle.deck.id) });
  }
  return entries;
}

export interface ImportResult {
  /** Ids of decks written (new ids for copies). */
  imported: string[];
  skipped: string[];
}

/**
 * Write a planned import. Progress is synced to each deck as it's written.
 * If no deck is active afterwards, the first imported deck becomes active.
 */
export async function applyImport(
  repo: Repository,
  plan: readonly ImportPlanEntry[],
  onConflict: ConflictPolicy,
  now: number,
  newId: () => string = () => crypto.randomUUID(),
): Promise<ImportResult> {
  await repo.init();
  const result: ImportResult = { imported: [], skipped: [] };

  for (const { bundle, existing } of plan) {
    let toWrite = bundle;
    if (existing) {
      if (onConflict === "skip") {
        result.skipped.push(bundle.deck.id);
        continue;
      }
      if (onConflict === "copy") toWrite = copyBundle(bundle, now, newId);
    }

    const { deck, history } = toWrite;
    await repo.saveDeck(deck);
    await repo.saveProgress(deck.id, syncProgress(deck, toWrite.progress, now).pairs);
    await repo.replaceHistory(deck.id, history);
    result.imported.push(deck.id);
  }

  const meta = await repo.getMeta();
  const ids = await repo.listDeckIds();
  const first = result.imported[0];
  if (first && (!meta.activeDeckId || !ids.includes(meta.activeDeckId))) await repo.setActiveDeck(first);
  return result;
}

// ---------------------------------------------------------------------------
// Updating an existing deck from a deck list (Anki-style "update")

export interface AnswerChange {
  term: string;
  /** Answers in the file that the deck doesn't have. */
  added: string[];
  /** Answers the deck has that the file doesn't: these would disappear. */
  removed: string[];
}

export interface DeckUpdatePlan {
  deckId: string;
  deckName: string;
  /** Terms in the file but not the deck: added as new pairs. */
  addedTerms: string[];
  /** Terms in the deck but not the file: kept or removed, the user's choice. */
  missingTerms: string[];
  /** Matched pairs whose answers differ. Their progress is kept. */
  changed: AnswerChange[];
  /** Matched pairs with identical answers. */
  unchangedCount: number;
}

export interface DeckUpdateOptions {
  /** Remove pairs that are in the deck but not in the file. */
  removeMissing: boolean;
}

/**
 * Compare a deck with a deck list, matching pairs by term. For matched pairs
 * the file's answers win; progress is never touched. Pure: writes nothing.
 */
export function planDeckUpdate(deck: Deck, list: DeckTemplate): DeckUpdatePlan {
  const fileByTerm = new Map<string, DeckTemplate["items"][number]>();
  for (const item of list.items) {
    const key = termKey(item.term);
    if (fileByTerm.has(key)) throw new ImportError(`The file lists ${item.term} more than once.`);
    fileByTerm.set(key, item);
  }
  const deckTerms = new Set(deck.items.map((item) => termKey(item.term)));

  const changed: AnswerChange[] = [];
  const missingTerms: string[] = [];
  let unchangedCount = 0;
  for (const item of deck.items) {
    const fromFile = fileByTerm.get(termKey(item.term));
    if (!fromFile) {
      missingTerms.push(item.term);
      continue;
    }
    const added = fromFile.answers.filter((a) => !item.answers.includes(a));
    const removed = item.answers.filter((a) => !fromFile.answers.includes(a));
    if (added.length || removed.length) changed.push({ term: item.term, added, removed });
    else unchangedCount += 1;
  }

  return {
    deckId: deck.id,
    deckName: deck.name,
    addedTerms: list.items.filter((i) => !deckTerms.has(termKey(i.term))).map((i) => i.term),
    missingTerms,
    changed,
    unchangedCount,
  };
}

/** Whether applying the plan would change anything. */
export function deckUpdateHasChanges(plan: DeckUpdatePlan, opts: DeckUpdateOptions): boolean {
  return plan.addedTerms.length > 0 || plan.changed.length > 0 || (opts.removeMissing && plan.missingTerms.length > 0);
}

/**
 * Apply a deck list to a stored deck: matched pairs take the file's answers
 * (and file order) and keep their progress, new pairs are added, and pairs
 * missing from the file are removed only if `removeMissing`. Returns the
 * saved deck. Review history is kept as-is.
 */
export async function applyDeckUpdate(
  repo: Repository,
  deckId: string,
  list: DeckTemplate,
  opts: DeckUpdateOptions,
  now: number,
  newId: () => string = () => crypto.randomUUID(),
): Promise<Deck> {
  const deck = await repo.getDeck(deckId);
  if (!deck) throw new ImportError("That deck no longer exists.");
  const plan = planDeckUpdate(deck, list); // re-check against current data
  const fileByTerm = new Map(list.items.map((item) => [termKey(item.term), item]));
  const changedTerms = new Set(plan.changed.map((c) => termKey(c.term)));

  const kept = deck.items
    .filter((item) => !opts.removeMissing || fileByTerm.has(termKey(item.term)))
    .map((item) => {
      const fromFile = fileByTerm.get(termKey(item.term));
      if (!fromFile) return item;
      const answersChanged = changedTerms.has(termKey(item.term));
      return { ...item, answers: [...fromFile.answers], updatedAt: answersChanged ? now : item.updatedAt };
    });
  const deckTerms = new Set(deck.items.map((item) => termKey(item.term)));
  const added = list.items
    .filter((item) => !deckTerms.has(termKey(item.term)))
    .map((item) => ({ id: newId(), term: item.term, answers: [...item.answers], updatedAt: now }));

  const updated: Deck = {
    ...deck,
    items: [...kept, ...added],
    updatedAt: deckUpdateHasChanges(plan, opts) ? now : deck.updatedAt,
  };
  await repo.saveDeck(updated);
  const progress = (await repo.getProgress(deckId)) ?? [];
  await repo.saveProgress(deckId, syncProgress(updated, progress, now).pairs);
  return updated;
}

/** Duplicate a bundle under fresh ids, carrying progress and history across. */
function copyBundle(bundle: DeckBundle, now: number, newId: () => string): DeckBundle {
  const idMap = new Map(bundle.deck.items.map((item) => [item.id, newId()]));
  const remap = (id: string) => idMap.get(id) ?? id;

  return {
    deck: {
      ...bundle.deck,
      id: newId(),
      name: `${bundle.deck.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      items: bundle.deck.items.map((item) => ({ ...item, id: remap(item.id), answers: [...item.answers] })),
    },
    progress: bundle.progress.map((p) => ({ ...p, pairId: remap(p.pairId), answerHistory: { ...p.answerHistory } })),
    history: bundle.history.map((e) => ({ ...e, pairId: remap(e.pairId) })),
  };
}
