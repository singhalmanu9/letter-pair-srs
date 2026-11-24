/** The review session: recall, reveal, tap the answer you thought of. */

import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionStats } from "../lib/engine";
import type { ReviewEvent } from "../lib/schemas";
import { stageName } from "../lib/srs";
import { errorMessage, Icon, plural } from "./common";
import { store, useStore } from "./store";

type Phase = "recall" | "revealed" | "other" | "timeout" | "done";

export function Review({ onExit }: { onExit: () => void }) {
  useStore();
  const { session, engine } = store.app;
  const limit = engine.config.sessionLimit;

  // Pick the first pair (or resume one restored after reload) before the first
  // render, so the pair is on screen immediately.
  const [phase, setPhase] = useState<Phase>(() => {
    if (limit !== null && session.reviewedEvents.length >= limit) return "done";
    const item = session.activeReview ? engine.getItem(session.activeReview.pairId) : session.startNextReview(Date.now());
    if (!item) return "done";
    return session.activeReview?.revealedAt != null && item.answers.length > 0 ? "revealed" : "recall";
  });
  const [now, setNow] = useState(Date.now());
  const [typed, setTyped] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [lastTimeout, setLastTimeout] = useState<ReviewEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = session.activeReview;
  const done = session.reviewedEvents.length;
  // Due pairs still to go in this session, including the one on screen.
  const due = engine.dueCount(Date.now());
  const left = limit === null ? due : Math.min(due, Math.max(0, limit - done));

  /** Start the next pair, or finish if the limit is hit or nothing is due. */
  const next = () => {
    setTyped("");
    setInputError(null);
    setLastTimeout(null);
    if (limit !== null && session.reviewedEvents.length >= limit) return setPhase("done");
    const item = session.activeReview ? session.engine.getItem(session.activeReview.pairId) : session.startNextReview(Date.now());
    if (!item) return setPhase("done");
    setPhase(session.activeReview?.revealedAt != null && item.answers.length > 0 ? "revealed" : "recall");
    setNow(Date.now());
  };

  // Countdown and auto-timeout while recalling.
  useEffect(() => {
    if (phase !== "recall") return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const event = session.checkTimeout(t);
      if (event) {
        setLastTimeout(event);
        setPhase("timeout");
        store.emit();
      }
    }, 100);
    return () => clearInterval(id);
  }, [phase]);

  // Fresh countdown when coming back to the app mid-recall.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        session.restartTimer(Date.now());
        setNow(Date.now());
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Keep the screen on during a session.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        if (document.visibilityState === "visible") lock = await navigator.wakeLock?.request("screen");
      } catch {
        /* not supported or denied: fine */
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, []);

  useEffect(() => {
    if (phase === "other" || (phase === "recall" && active?.answers.length === 0)) inputRef.current?.focus();
  }, [phase, active?.pairId]);

  const run = (action: () => void) => {
    try {
      action();
      store.emit();
      next();
    } catch (error) {
      // Most likely the recall time ran out a moment ago.
      if (!session.activeReview) {
        setPhase("timeout");
        store.emit();
      } else setInputError(errorMessage(error));
    }
  };

  const reveal = () => {
    try {
      session.revealAnswers(Date.now());
      setPhase("revealed");
    } catch {
      setPhase("timeout");
    }
    store.emit();
  };

  const quit = () => {
    session.abandonActiveReview();
    store.emit();
    if (session.reviewedEvents.length === 0) onExit();
    else setPhase("done");
  };

  const submitTyped = () => {
    if (!active) return;
    if (typed.trim() === "") return setInputError("Type what you came up with first.");
    run(() =>
      active.answers.length === 0
        ? session.submitNewAnswer(typed, Date.now())
        : session.submitOther(typed, Date.now()),
    );
  };

  // Keyboard shortcuts (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        if (e.key === "Escape" && phase === "other") setPhase("revealed");
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") return quit();
      if (phase === "recall" && active && active.answers.length > 0 && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        return reveal();
      }
      if (phase === "timeout" && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        return next();
      }
      if (phase === "revealed" && active) {
        const n = Number(e.key);
        const sorted = sortedAnswers();
        if (n >= 1 && n <= sorted.length) return run(() => session.gradePass(sorted[n - 1]!, Date.now()));
        if (e.key === "f") return run(() => session.gradeFail(null, Date.now()));
        if (e.key === "e") {
          e.preventDefault();
          setPhase("other");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Accepted answers, most-used first. */
  const sortedAnswers = (): string[] => {
    if (!active) return [];
    const history = engine.getPairState(active.pairId)?.answerHistory ?? {};
    return [...active.answers].sort((a, b) => (history[b] ?? 0) - (history[a] ?? 0));
  };

  if (phase === "done") return <Summary stats={session.getSessionStats()} onExit={onExit} />;

  const pair = active ? engine.getPairState(active.pairId) : null;
  const term = active?.term ?? lastTimeout?.term ?? "";
  const timeoutMs = active?.timer.timeoutMs ?? 1;
  const remainingMs = phase === "recall" ? (session.timeRemaining(now) ?? 0) : (session.timeRemaining(Date.now()) ?? 0);
  const unanswered = active !== null && active.answers.length === 0;
  const history = pair?.answerHistory ?? {};

  return (
    <div class="review">
      <header class="review-top">
        <button class="icon-btn" onClick={quit} aria-label="End session">
          <Icon name="x" />
        </button>
        <span class="muted">
          {done} done · {left} left
        </span>
        <span class="muted">{pair ? stageName(pair.stage, engine.config.srs) : ""}</span>
      </header>
      <div class="timer-track" aria-hidden="true">
        <div class="timer-fill" style={{ width: `${phase === "timeout" ? 0 : (remainingMs / timeoutMs) * 100}%` }} />
      </div>

      <div class={`review-term ${phase === "recall" ? "big" : ""}`} aria-live="polite">
        {term}
      </div>

      <div class="review-actions">
        {phase === "recall" && !unanswered && (
          <>
            <p class="hint">Think of your image, then reveal</p>
            <button class="btn btn-primary btn-tall" onClick={reveal}>
              Reveal <kbd>Space</kbd>
            </button>
          </>
        )}

        {phase === "recall" && unanswered && (
          <TypedAnswer
            label="No answer yet. What did you come up with?"
            value={typed}
            error={inputError}
            inputRef={inputRef}
            onInput={(v) => {
              setTyped(v);
              setInputError(null);
              // Typing means you've recalled something: stop the clock.
              if (active && active.revealedAt === null && v.trim()) session.revealAnswers(Date.now());
            }}
            onSubmit={submitTyped}
            submitLabel="Save and continue"
            secondary={{
              label: "Didn't get one (comes back)",
              run: () =>
                run(() => {
                  session.revealAnswers(Date.now());
                  session.gradeFail(null, Date.now());
                }),
            }}
          />
        )}

        {phase === "revealed" && active && (
          <>
            <p class="hint">Which one did you think of?</p>
            {sortedAnswers().map((answer, i) => (
              <button key={answer} class="btn answer" onClick={() => run(() => session.gradePass(answer, Date.now()))}>
                <span>{answer}</span>
                <span class="answer-meta">
                  {history[answer] ? `used ${history[answer]}×` : ""}
                  {i < 9 && <kbd>{i + 1}</kbd>}
                </span>
              </button>
            ))}
            <div class="row-2">
              <button class="btn btn-danger-text" onClick={() => run(() => session.gradeFail(null, Date.now()))}>
                Didn't get it <kbd>F</kbd>
              </button>
              <button class="btn" onClick={() => setPhase("other")}>
                Something else <kbd>E</kbd>
              </button>
            </div>
          </>
        )}

        {phase === "other" && active && (
          <TypedAnswer
            label="What did you come up with? It'll be added to this pair's answers."
            value={typed}
            error={inputError}
            inputRef={inputRef}
            onInput={(v) => {
              setTyped(v);
              setInputError(null);
            }}
            onSubmit={submitTyped}
            submitLabel="Save"
            secondary={{ label: "Back", run: () => setPhase("revealed") }}
          />
        )}

        {phase === "timeout" && (
          <>
            <p class="hint">Time's up.</p>
            {lastTimeout && (store.app.engine.getItem(lastTimeout.pairId)?.answers.length ?? 0) > 0 && (
              <p class="timeout-answers">{store.app.engine.getItem(lastTimeout.pairId)!.answers.join(" · ")}</p>
            )}
            <button class="btn btn-primary btn-tall" onClick={next}>
              Next <kbd>Space</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TypedAnswer(props: {
  label: string;
  value: string;
  error: string | null;
  inputRef: { current: HTMLInputElement | null };
  onInput: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  secondary: { label: string; run: () => void };
}) {
  return (
    <form
      class="typed"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <label class="hint" for="typed-answer">
        {props.label}
      </label>
      <input
        id="typed-answer"
        ref={props.inputRef}
        class="input"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        autocomplete="off"
        autocapitalize="words"
        enterkeyhint="done"
        placeholder="Big Deal"
      />
      {props.error && <p class="field-error">{props.error}</p>}
      <button type="submit" class="btn btn-primary btn-tall">
        {props.submitLabel}
      </button>
      <button type="button" class="btn" onClick={props.secondary.run}>
        {props.secondary.label}
      </button>
    </form>
  );
}

function Summary({ stats, onExit }: { stats: SessionStats; onExit: () => void }) {
  const rows: [string, number][] = [
    ["Got it", stats.passed],
    ["Something else", stats.other],
    ["Didn't get it", stats.failed],
    ["Timed out", stats.timedOut],
  ];
  return (
    <div class="review summary">
      <div class="summary-body">
        <h1>{stats.total === 0 ? "Nothing to review" : "Session done"}</h1>
        {stats.total > 0 && (
          <>
            <p class="muted">{plural(stats.total, "pair")} reviewed</p>
            <ul class="summary-list">
              {rows.map(([label, n]) => (
                <li key={label}>
                  <span>{label}</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <button class="btn btn-primary btn-tall" onClick={onExit}>
        Back home
      </button>
    </div>
  );
}
