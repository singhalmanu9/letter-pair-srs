import { useEffect, useState } from "preact/hooks";
import { stageName } from "../lib/srs";
import { formatDuration, plural } from "./common";
import { store, useStore } from "./store";

export function Home({ onStart }: { onStart: () => void }) {
  useStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const { engine, deck } = store.app;
  const due = engine.dueCount(now);
  const limit = engine.config.sessionLimit;
  const sessionSize = limit === null ? due : Math.min(due, limit);
  const nextIn = engine.msUntilNextDue(now);
  const unanswered = engine.unansweredCount();
  const counts = engine.stageCounts();
  const max = Math.max(1, ...counts);

  return (
    <div class="page home">
      <p class="muted">{deck.name}</p>
      <section class="due">
        <span class="muted">Due now</span>
        <span class="due-count">{due}</span>
        <span class="muted">
          {due > 0
            ? `${plural(deck.items.length, "pair")} in this deck`
            : nextIn !== null
              ? `Next review in ${formatDuration(nextIn)}`
              : deck.items.length === 0
                ? "Add some pairs in the Deck tab to get started"
                : "Everything is burned. Nice."}
        </span>
      </section>

      {unanswered > 0 && (
        <p class="notice">
          {plural(unanswered, "pair needs", "pairs need")} an answer. They'll come up in reviews.
        </p>
      )}

      <section>
        <h2 class="section-label">Levels</h2>
        <div class="levels" role="img" aria-label="Pairs per level">
          {counts.map((n, stage) => (
            <div class="level" key={stage} title={`${stageName(stage, engine.config.srs)}: ${n}`}>
              <span class="level-n">{n || ""}</span>
              <div class="level-bar" style={{ height: `${(n / max) * 100}%` }} />
              <span class="level-label">{stage === 0 ? "New" : stage}</span>
            </div>
          ))}
        </div>
      </section>

      <div class="spacer" />
      <button class="btn btn-primary btn-tall" disabled={due === 0} onClick={onStart}>
        {due === 0 ? "All caught up" : `Start reviews (${sessionSize})`}
      </button>
    </div>
  );
}
