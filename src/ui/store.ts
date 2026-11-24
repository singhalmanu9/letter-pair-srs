/**
 * App-level state for the UI: loads data through the bootstrap, holds the
 * current deck/session/settings, and exposes the actions screens need.
 * Components subscribe with `useStore()` and re-render on `emit()`.
 */

import { useEffect, useState } from "preact/hooks";
import { createDeck, loadApp, type AppContext, type LoadResult } from "../app/bootstrap";
import { applyDeckUpdate, applyImport, backupFileName, createBackup, createRawDump } from "../lib/backup";
import type { ConflictPolicy, DeckUpdateOptions, ImportPlanEntry } from "../lib/backup";
import { configFromSettings, Repository, type Settings } from "../lib/repository";
import { addAnswerToPair, removeAnswerFromPair, termKey, type PairState } from "../lib/schemas";
import { getBrowserStore, requestPersistentStorage, type AsyncKeyValueStore } from "../lib/storage";
import type { DeckTemplate } from "../lib/templates";
import { applySchemeUpdate, generatePairTerms, type MemoProfile, type SchemeUpdatePlan } from "../lib/scheme";
import { downloadJSON } from "../app/files";

export type Status =
  | { kind: "loading" }
  | { kind: "ready"; app: AppContext }
  | { kind: "no-deck" }
  | { kind: "error"; error: unknown; key: string | null };

export class AppStore {
  readonly kv: AsyncKeyValueStore;
  readonly durable: boolean;
  readonly repo: Repository;
  status: Status = { kind: "loading" };
  settings: Settings | null = null;
  /** Letter scheme and orientation, or null if the user skipped setting one up. */
  profile: MemoProfile | null = null;
  /** Bumped on every change so components re-render. */
  version = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    const { store, durable } = getBrowserStore();
    this.kv = store;
    this.durable = durable;
    this.repo = new Repository(store);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  get app(): AppContext {
    if (this.status.kind !== "ready") throw new Error("App not ready");
    return this.status.app;
  }

  async init(): Promise<void> {
    void requestPersistentStorage();
    await this.reload();
  }

  /** (Re)load everything from storage, e.g. after structural deck changes. */
  async reload(): Promise<void> {
    if (this.status.kind === "ready") await this.status.app.writes.idle();
    try {
      await this.repo.init();
      this.settings = await this.repo.getSettings();
      this.profile = await this.repo.getProfile();
    } catch (error) {
      this.setResult({ kind: "error", error, key: null });
      return;
    }
    const result = await loadApp(this.repo, configFromSettings(this.settings), {
      now: Date.now(),
      onPersistError: (e) => console.error("Save failed", e),
    });
    this.setResult(result);
  }

  private setResult(result: LoadResult): void {
    this.status = result;
    this.emit();
  }

  // --- Decks -----------------------------------------------------------------

  async startFromTemplate(template: DeckTemplate): Promise<void> {
    await createDeck(this.repo, template, Date.now());
    await this.reload();
  }

  /** Save the profile and create a deck with every pair it generates (no answers yet). */
  async createDeckFromProfile(profile: MemoProfile, name = "My letter pairs"): Promise<void> {
    await this.repo.init();
    await this.repo.saveProfile(profile);
    const now = Date.now();
    const deck = {
      id: crypto.randomUUID(),
      name,
      templateId: "scheme",
      createdAt: now,
      updatedAt: now,
      items: generatePairTerms(profile).map((term) => ({ id: crypto.randomUUID(), term, answers: [], updatedAt: now })),
    };
    await this.repo.saveDeck(deck);
    await this.repo.setActiveDeck(deck.id);
    await this.reload();
  }

  /** Save a changed profile and bring the active deck in line with it. */
  async applySchemeChange(profile: MemoProfile, plan: SchemeUpdatePlan, removeMissing: boolean): Promise<void> {
    await this.repo.saveProfile(profile);
    if (this.status.kind === "ready") {
      await this.app.writes.idle();
      await this.repo.saveDeck(applySchemeUpdate(this.app.deck, plan, removeMissing, Date.now()));
    }
    await this.reload();
  }

  async switchDeck(deckId: string): Promise<void> {
    await this.repo.setActiveDeck(deckId);
    await this.reload();
  }

  /** Add a pair with no answers yet. Returns its id, or an error message. */
  async addPair(term: string): Promise<{ id: string } | { error: string }> {
    const trimmed = term.trim();
    if (trimmed === "") return { error: "Enter the letters for the pair." };
    const deck = this.app.deck;
    if (deck.items.some((i) => termKey(i.term) === termKey(trimmed))) return { error: `${trimmed} is already in the deck.` };
    const now = Date.now();
    const id = crypto.randomUUID();
    deck.items.push({ id, term: trimmed, answers: [], updatedAt: now });
    deck.updatedAt = now;
    await this.repo.saveDeck(deck);
    await this.reload();
    return { id };
  }

  async deletePair(pairId: string): Promise<void> {
    const deck = this.app.deck;
    deck.items = deck.items.filter((i) => i.id !== pairId);
    deck.updatedAt = Date.now();
    await this.repo.saveDeck(deck);
    await this.reload();
  }

  /** Add an accepted answer. Returns false if blank or already there. */
  async addAnswer(pairId: string, answer: string): Promise<boolean> {
    const { deck } = this.app;
    if (!addAnswerToPair(deck, pairId, answer, Date.now())) return false;
    await this.repo.saveDeck(deck);
    this.emit();
    return true;
  }

  /**
   * Remove an accepted answer. Returns an undo function that puts the answer
   * (and the pair's progress, if removing it reset the pair) back.
   */
  async removeAnswer(pairId: string, answer: string): Promise<(() => Promise<void>) | null> {
    const { deck, engine } = this.app;
    const item = deck.items.find((i) => i.id === pairId);
    const pair = engine.getPairState(pairId);
    if (!item || !pair) return null;
    const index = item.answers.indexOf(answer);
    const before: PairState = structuredClone(pair);
    const now = Date.now();
    if (!removeAnswerFromPair(deck, pairId, answer, now)) return null;
    const reset = engine.syncPair(pairId, now);
    await this.repo.saveDeck(deck);
    if (reset) await this.repo.saveProgress(deck.id, engine.pairs);
    this.emit();

    return async () => {
      if (item.answers.includes(answer)) return;
      item.answers.splice(Math.min(index, item.answers.length), 0, answer);
      item.updatedAt = Date.now();
      Object.assign(pair, before);
      await this.repo.saveDeck(deck);
      await this.repo.saveProgress(deck.id, engine.pairs);
      this.emit();
    };
  }

  // --- Settings --------------------------------------------------------------

  async saveSettings(settings: Settings): Promise<void> {
    await this.repo.saveSettings(settings);
    await this.reload();
  }

  // --- Backup and import -----------------------------------------------------

  async exportBackup(): Promise<void> {
    const now = Date.now();
    downloadJSON(backupFileName(now), await createBackup(this.repo, now));
    const settings = { ...(this.settings ?? (await this.repo.getSettings())), lastBackupAt: now };
    await this.repo.saveSettings(settings);
    this.settings = settings;
    this.emit();
  }

  async downloadRawData(): Promise<void> {
    const now = Date.now();
    downloadJSON(backupFileName(now, "raw"), await createRawDump(this.kv, now));
  }

  async applyImport(plan: ImportPlanEntry[], policy: ConflictPolicy): Promise<number> {
    const result = await applyImport(this.repo, plan, policy, Date.now());
    await this.reload();
    return result.imported.length;
  }

  async applyDeckUpdate(deckId: string, list: DeckTemplate, opts: DeckUpdateOptions): Promise<void> {
    await applyDeckUpdate(this.repo, deckId, list, opts, Date.now());
    await this.reload();
  }

  async resetAll(): Promise<void> {
    await this.repo.resetAll();
    await this.reload();
  }
}

export const store = new AppStore();

/** Re-render the calling component whenever the store changes. */
export function useStore(): AppStore {
  const [, setVersion] = useState(store.version);
  useEffect(() => store.subscribe(() => setVersion(store.version)), []);
  return store;
}
