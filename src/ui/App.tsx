import { useEffect, useState } from "preact/hooks";
import { DialogHost, errorMessage, Icon, ToastHost, confirmAction } from "./common";
import { Deck } from "./Deck";
import { Home } from "./Home";
import { FillIn, Onboarding } from "./Onboarding";
import { Review } from "./Review";
import { importFile, Settings } from "./Settings";
import { store, useStore } from "./store";

type Tab = "home" | "deck" | "stats" | "settings";

const TABS: { id: Tab; label: string; icon: "home" | "cards" | "stats" | "settings" }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "deck", label: "Deck", icon: "cards" },
  { id: "stats", label: "Stats", icon: "stats" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function App() {
  useStore();
  const [tab, setTab] = useState<Tab>("home");
  const [reviewing, setReviewing] = useState(false);
  const [fillingIn, setFillingIn] = useState(false);

  useEffect(() => {
    void store.init();
  }, []);

  // A review left open before a reload resumes straight away.
  useEffect(() => {
    if (store.status.kind === "ready" && store.app.session.activeReview) setReviewing(true);
  }, [store.status.kind === "ready" ? store.status.app : null]);

  const status = store.status;
  let content;
  if (status.kind === "loading") content = <div class="center muted">Loading…</div>;
  else if (status.kind === "error") content = <ErrorScreen error={status.error} storageKey={status.key} />;
  else if (status.kind === "no-deck")
    content = <Onboarding onImport={() => void importFile()} onCreated={() => setFillingIn(true)} />;
  else if (fillingIn) content = <FillIn onDone={() => setFillingIn(false)} />;
  else if (reviewing) content = <Review onExit={() => setReviewing(false)} />;
  else
    content = (
      <div class="shell">
        <nav class="tabs" aria-label="Main">
          <span class="brand">BLD Letter Pairs SRS</span>
          {TABS.map((t) => (
            <button key={t.id} class={`tab ${tab === t.id ? "on" : ""}`} aria-current={tab === t.id} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={22} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <main class="main">
          {tab === "home" && <Home onStart={() => setReviewing(true)} onFillIn={() => setFillingIn(true)} />}
          {tab === "deck" && <Deck />}
          {tab === "stats" && (
            <div class="page center">
              <h1>Stats</h1>
              <p class="muted">Coming soon.</p>
            </div>
          )}
          {tab === "settings" && <Settings />}
        </main>
      </div>
    );

  return (
    <>
      {content}
      <DialogHost />
      <ToastHost />
    </>
  );
}

function ErrorScreen({ error, storageKey }: { error: unknown; storageKey: string | null }) {
  const reset = async () => {
    const ok = await confirmAction(
      "Delete all data?",
      <p>Download the raw data first if you want to try recovering it.</p>,
      "Delete everything",
      true,
    );
    if (ok) await store.resetAll();
  };
  return (
    <div class="page center error-screen">
      <h1>Your saved data couldn't be read</h1>
      <p class="muted">
        {storageKey ? `The problem is in “${storageKey}”. ` : ""}
        {errorMessage(error)}
      </p>
      <p>Nothing has been changed. Download a copy of the raw data before doing anything else.</p>
      <button class="btn btn-primary" onClick={() => void store.downloadRawData()}>
        Download raw data
      </button>
      <button class="btn btn-danger-text" onClick={() => void reset()}>
        Delete all data and start over
      </button>
    </div>
  );
}
