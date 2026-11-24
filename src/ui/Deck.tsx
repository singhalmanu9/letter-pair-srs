/** Browse and edit the deck: list with search on the left, pair editor as a sheet (phone) or pane (desktop). */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hasAnswers, mostCommonAnswer, type DeckItem } from "../lib/schemas";
import { stageName } from "../lib/srs";
import { ask, confirmAction, formatDuration, Icon, toast } from "./common";
import { store, useStore } from "./store";

export function Deck() {
  useStore();
  const { deck, engine } = store.app;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...deck.items].sort((a, b) => a.term.localeCompare(b.term));
    if (!q) return sorted;
    return sorted.filter((i) => i.term.toLowerCase().includes(q) || i.answers.some((a) => a.toLowerCase().includes(q)));
  }, [deck.items, query, store.version]);

  const letters = useMemo(() => [...new Set(items.map((i) => i.term[0]!.toUpperCase()))], [items]);
  const selected = deck.items.find((i) => i.id === selectedId) ?? null;

  const jumpTo = (letter: string) => {
    listRef.current?.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: "start" });
  };

  const addPair = async () => {
    let term = "";
    const choice = await ask(
      "Add a pair",
      <input
        class="input"
        placeholder="AB"
        autocapitalize="characters"
        autocomplete="off"
        maxLength={8}
        onInput={(e) => (term = e.currentTarget.value)}
        ref={(el) => setTimeout(() => el?.focus(), 0)}
      />,
      [
        { label: "Cancel", value: false, tone: "plain" },
        { label: "Add", value: true, tone: "primary" },
      ],
    );
    if (!choice) return;
    const result = await store.addPair(term.toUpperCase());
    if ("error" in result) toast(result.error);
    else setSelectedId(result.id);
  };

  let lastLetter = "";
  return (
    <div class={`page deck ${selected ? "has-selection" : ""}`}>
      <div class="deck-list-pane">
        <div class="deck-toolbar">
          <div class="search">
            <Icon name="search" size={18} />
            <input
              class="input"
              type="search"
              placeholder="Search pairs or answers"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <button class="btn icon-btn-bordered" onClick={addPair} aria-label="Add pair">
            <Icon name="plus" />
          </button>
        </div>
        {letters.length > 1 && (
          <nav class="letter-strip" aria-label="Jump to letter">
            {letters.map((l) => (
              <button key={l} onClick={() => jumpTo(l)}>
                {l}
              </button>
            ))}
          </nav>
        )}
        <div class="deck-list" ref={listRef}>
          {items.length === 0 && <p class="empty">{query ? "No pairs match." : "No pairs yet. Add one with +."}</p>}
          {items.map((item) => {
            const letter = item.term[0]!.toUpperCase();
            const anchor = letter !== lastLetter ? letter : undefined;
            lastLetter = letter;
            const pair = engine.getPairState(item.id);
            return (
              <button
                key={item.id}
                data-letter={anchor}
                class={`deck-row ${item.id === selectedId ? "selected" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span class="deck-term">{item.term}</span>
                <span class="deck-answers">
                  {hasAnswers(item) ? (
                    <>
                      {item.answers[0]}
                      {item.answers.length > 1 && <span class="muted"> +{item.answers.length - 1}</span>}
                    </>
                  ) : (
                    <span class="warn-text">needs an answer</span>
                  )}
                </span>
                <span class="deck-level">{pair ? shortStage(pair.stage) : ""}</span>
              </button>
            );
          })}
        </div>
      </div>

      {selected && <PairEditor item={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function shortStage(stage: number): string {
  return stage === 0 ? "New" : `L${stage}`;
}

function PairEditor({ item, onClose }: { item: DeckItem; onClose: () => void }) {
  useStore();
  const { engine } = store.app;
  const pair = engine.getPairState(item.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".scrim")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = async (e: Event) => {
    e.preventDefault();
    if (draft.trim() === "") return setError("Type an answer first.");
    if (item.answers.includes(draft.trim())) return setError("That answer is already there.");
    await store.addAnswer(item.id, draft);
    setDraft("");
    setError(null);
  };

  const remove = async (answer: string) => {
    const undo = await store.removeAnswer(item.id, answer);
    if (undo) toast(`Removed "${answer}"`, { label: "Undo", run: () => void undo() });
  };

  const deletePair = async () => {
    const ok = await confirmAction(
      `Delete ${item.term}?`,
      <p>Its answers and progress will be removed. You can add the pair again later, but it starts over.</p>,
      "Delete pair",
      true,
    );
    if (!ok) return;
    onClose();
    await store.deletePair(item.id);
    toast(`Deleted ${item.term}`);
  };

  const now = Date.now();
  const usual = pair ? mostCommonAnswer(pair) : null;
  const usualCount = usual && pair ? pair.answerHistory[usual] : 0;
  const totalAnswers = pair ? Object.values(pair.answerHistory).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <div class="sheet-scrim" onClick={onClose} />
      <section class="pair-editor" aria-label={`Edit ${item.term}`}>
        <div class="sheet-handle" />
        <div class="editor-head">
          <span class="editor-term">{item.term}</span>
          <span class="muted">
            {pair && stageName(pair.stage, engine.config.srs)}
            {pair?.nextDueAt != null && (pair.nextDueAt <= now ? " · due now" : ` · due in ${formatDuration(pair.nextDueAt - now)}`)}
          </span>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <h3 class="section-label">Answers</h3>
        {item.answers.length === 0 ? (
          <p class="warn-text">No answers yet. Add one, or come up with one when it shows up in a review.</p>
        ) : (
          <div class="chips">
            {item.answers.map((a) => (
              <span class="chip" key={a}>
                {a}
                <button onClick={() => remove(a)} aria-label={`Remove ${a}`}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <form class="add-answer" onSubmit={add}>
          <input
            class="input"
            placeholder="Add an answer"
            value={draft}
            autocomplete="off"
            autocapitalize="words"
            enterkeyhint="done"
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              setError(null);
            }}
          />
          <button class="btn" type="submit">
            Add
          </button>
        </form>
        {error && <p class="field-error">{error}</p>}

        {pair && pair.responseCount + pair.timeoutCount > 0 && (
          <p class="muted editor-stats">
            {usual && `You usually say ${usual} (${usualCount} of ${totalAnswers}). `}
            Got it {pair.passCount}, something else {pair.otherCount}, didn't get it {pair.failCount}, timed out{" "}
            {pair.timeoutCount}.
          </p>
        )}

        <button class="btn btn-danger-text delete-pair" onClick={deletePair}>
          <Icon name="trash" size={18} /> Delete pair
        </button>
      </section>
    </>
  );
}
