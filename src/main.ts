// Placeholder entry point: loads real data from localStorage and shows a
// summary. The review UI replaces this in a later step.
import { createDeck, loadApp } from "./app/bootstrap";
import { TEMPLATES } from "./data/templates";
import { DEFAULT_CONFIG } from "./lib/config";
import { Repository } from "./lib/repository";
import { stageName } from "./lib/srs";
import { getBrowserStore, requestPersistentStorage } from "./lib/storage";

async function main(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app")!;
  const { store, durable } = getBrowserStore();
  const repo = new Repository(store);
  const persistent = await requestPersistentStorage();
  const opts = { now: Date.now(), onPersistError: (e: unknown) => console.error("Save failed", e) };

  let result = await loadApp(repo, DEFAULT_CONFIG, opts);
  if (result.kind === "no-deck") {
    // Onboarding UI comes later; for now start from the first template.
    await createDeck(repo, TEMPLATES[0]!, opts.now);
    result = await loadApp(repo, DEFAULT_CONFIG, opts);
  }

  if (result.kind === "error") {
    root.textContent = `Couldn't load saved data${result.key ? ` (${result.key})` : ""}: ${String(result.error)}`;
    return;
  }
  if (result.kind !== "ready") return;

  const { deck, engine } = result.app;
  const stages = engine
    .stageCounts()
    .map((n, stage) => (n ? `${stageName(stage, DEFAULT_CONFIG.srs)}: ${n}` : null))
    .filter(Boolean)
    .join(", ");

  root.textContent =
    `${deck.name}: ${deck.items.length} pairs, ${engine.dueCount(Date.now())} due now. ` +
    `Stages: ${stages || "none"}. ` +
    `Storage: ${durable ? "localStorage" : "memory only (will not survive reload)"}` +
    `${persistent ? ", persistent" : ""}.`;
}

void main();
