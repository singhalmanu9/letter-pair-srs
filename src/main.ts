// Placeholder entry point: loads real data from localStorage, shows a
// summary, and offers export/import. The review UI replaces this later.
import { createDeck, loadApp } from "./app/bootstrap";
import { downloadJSON, pickTextFile } from "./app/files";
import { TEMPLATES } from "./data/templates";
import {
  applyImport,
  backupFileName,
  createBackup,
  createRawDump,
  ImportError,
  parseImport,
  planImport,
} from "./lib/backup";
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

async function importFile(): Promise<void> {
  const file = await pickTextFile();
  if (!file) return;
  const now = Date.now();
  const plan = await planImport(repo, parseImport(file.text, file.name), now);

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
