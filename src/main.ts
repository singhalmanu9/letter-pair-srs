// Placeholder entry point: proves the engine loads in the browser.
// The real review UI replaces this in a later step.
import sampleDeck from "./data/deck.json";
import { ReviewEngine } from "./lib/engine";
import { loadDeck, loadState, MemoryStore } from "./lib/persistence";

const store = new MemoryStore();
const deck = loadDeck(store, sampleDeck);
const engine = new ReviewEngine(deck, loadState(store, deck));
const due = engine.getDuePair();

document.querySelector<HTMLElement>("#app")!.textContent =
  `Letter Pair SRS: ${deck.items.length} pairs loaded. Next due: ${due?.term ?? "none"}.`;
