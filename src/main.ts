// Placeholder entry point: loads real data from localStorage, shows a
// summary, and offers export/import. The review UI replaces this later.
import { createDeck, loadApp } from "./app/bootstrap";
import { downloadJSON, pickTextFile } from "./app/files";
import { TEMPLATES } from "./data/templates";
import {
  applyDeckUpdate,
  applyImport,
  backupFileName,
  createBackup,
  createRawDump,
  deckUpdateHasChanges,
  ImportError,
  parseImport,
  planDeckUpdate,
  planImport,
  type DeckUpdateOptions,
  type DeckUpdatePlan,
} from "./lib/backup";
import type { DeckTemplate } from "./lib/templates";
import { DEFAULT_CONFIG } from "./lib/config";
import { Repository } from "./lib/repository";
import { stageName } from "./lib/srs";
import { getBrowserStore, requestPersistentStorage } from "./lib/storage";

const root = document.querySelector<HTMLElement>("#app")!;
const { store, durable } = getBrowserStore();
const repo = new Repository(store);

function button(label: string, onClick: () => Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", () => {
    onClick().catch((e: unknown) => alert(e instanceof ImportError ? e.message : `Something went wrong: ${String(e)}`));
  });
  return b;
}

async function exportBackup(): Promise<void> {
  const now = Date.now();
  downloadJSON(backupFileName(now), await createBackup(repo, now));
}

const MAX_LISTED = 8;
const list = (items: string[]) =>
  items.slice(0, MAX_LISTED).join(", ") + (items.length > MAX_LISTED ? `, and ${items.length - MAX_LISTED} more` : "");

/** Preview text for updating a deck, calling out answers that would disappear. */
function describeDeckUpdate(plan: DeckUpdatePlan, opts: DeckUpdateOptions): string {
  const lines = [`Update "${plan.deckName}" from this file:`, ""];
  if (plan.addedTerms.length) lines.push(`+ ${plan.addedTerms.length} new pair(s): ${list(plan.addedTerms)}`);
  const gained = plan.changed.filter((c) => c.added.length);
  if (gained.length) lines.push(`~ New answers for ${gained.length} pair(s): ${list(gained.map((c) => c.term))}`);
  if (opts.removeMissing && plan.missingTerms.length) {
    lines.push(`- ${plan.missingTerms.length} pair(s) removed, with their progress: ${list(plan.missingTerms)}`);
  }
  const lost = plan.changed.filter((c) => c.removed.length);
  if (lost.length) {
    lines.push("", "⚠ These answers would disappear:");
    for (const c of lost.slice(0, MAX_LISTED)) lines.push(`   ${c.term}: ${c.removed.map((a) => `"${a}"`).join(", ")}`);
    if (lost.length > MAX_LISTED) lines.push(`   …and ${lost.length - MAX_LISTED} more pair(s)`);
  }
  lines.push("", "Progress is kept for every pair that stays.");
  return lines.join("\n");
}

/** Update the active deck from a deck list. Returns false if the user backed out. */
async function updateDeckFromList(deckId: string, source: DeckTemplate): Promise<boolean> {
  const deck = await repo.getDeck(deckId);
  if (!deck) return false;
  const plan = planDeckUpdate(deck, source);

  let removeMissing = false;
  if (plan.missingTerms.length) {
    removeMissing = confirm(
      `${plan.missingTerms.length} pair(s) in "${deck.name}" aren't in the file: ${list(plan.missingTerms)}.\n\n` +
        `OK: remove them (their progress is deleted).\nCancel: keep them.`,
    );
  }
  const opts = { removeMissing };
  if (!deckUpdateHasChanges(plan, opts)) {
    alert(`"${deck.name}" already matches this file. Nothing to change.`);
    return false;
  }
  if (!confirm(describeDeckUpdate(plan, opts))) return false;

  await applyDeckUpdate(repo, deckId, source, opts, Date.now());
  return true;
}

async function importFile(): Promise<void> {
  const file = await pickTextFile();
  if (!file) return;
  const now = Date.now();
  const source = parseImport(file.text, file.name);

  const activeDeckId = (await repo.getMeta()).activeDeckId;
  const activeDeck = activeDeckId ? await repo.getDeck(activeDeckId) : null;
  if (source.kind === "deck-list" && activeDeck) {
    const update = confirm(
      `Use this file to update your current deck "${activeDeck.name}"?\n\n` +
        `OK: update it (pairs are matched by letters; progress is kept).\nCancel: import as a separate new deck.`,
    );
    if (update) {
      if (await updateDeckFromList(activeDeck.id, source.template)) location.reload();
      return;
    }
  }

  const plan = await planImport(repo, source, now);

  const conflicts = plan.filter((e) => e.existing);
  let policy: "replace" | "copy" = "replace";
  if (conflicts.length > 0) {
    const names = conflicts.map((e) => `"${e.bundle.deck.name}"`).join(", ");
    policy = confirm(
      `${names} already exist${conflicts.length === 1 ? "s" : ""} here.\n\n` +
        `OK: replace with the version from the file (current progress for ${conflicts.length === 1 ? "it" : "them"} is lost).\n` +
        `Cancel: import as a separate copy.`,
    )
      ? "replace"
      : "copy";
  }
  const result = await applyImport(repo, plan, policy, now);
  alert(`Imported ${result.imported.length} deck${result.imported.length === 1 ? "" : "s"}.`);
  location.reload();
}

async function main(): Promise<void> {
  const persistent = await requestPersistentStorage();
  const opts = { now: Date.now(), onPersistError: (e: unknown) => console.error("Save failed", e) };

  let result = await loadApp(repo, DEFAULT_CONFIG, opts);
  if (result.kind === "no-deck") {
    // Onboarding UI comes later; for now start from the first template.
    await createDeck(repo, TEMPLATES[0]!, opts.now);
    result = await loadApp(repo, DEFAULT_CONFIG, opts);
  }

  const summary = document.createElement("p");
  root.append(summary);

  if (result.kind === "error") {
    summary.textContent = `Couldn't load saved data${result.key ? ` (${result.key})` : ""}: ${String(result.error)}`;
  } else if (result.kind === "ready") {
    const { deck, engine } = result.app;
    const stages = engine
      .stageCounts()
      .map((n, stage) => (n ? `${stageName(stage, DEFAULT_CONFIG.srs)}: ${n}` : null))
      .filter(Boolean)
      .join(", ");
    const otherDecks = (await repo.listDeckIds()).length - 1;
    summary.textContent =
      `${deck.name}: ${deck.items.length} pairs, ${engine.dueCount(Date.now())} due now. ` +
      `Stages: ${stages || "none"}. ` +
      (engine.unansweredCount() ? `${engine.unansweredCount()} without answers yet. ` : "") +
      (otherDecks > 0 ? `(${otherDecks} other deck${otherDecks === 1 ? "" : "s"} stored.) ` : "") +
      `Storage: ${durable ? "localStorage" : "memory only (will not survive reload)"}` +
      `${persistent ? ", persistent" : ""}.`;
  }

  if (result.kind === "error") {
    // A normal backup would fail on the unreadable data; save it raw instead.
    root.append(
      button("Download raw data", async () => {
        const now = Date.now();
        downloadJSON(backupFileName(now, "raw"), await createRawDump(store, now));
      }),
    );
  } else {
    root.append(button("Export backup", exportBackup), " ", button("Import file", importFile));
  }
}

void main();
