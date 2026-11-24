import { useEffect, useState } from "preact/hooks";
import { pickTextFile } from "../app/files";
import { deckUpdateHasChanges, ImportError, parseImport, planDeckUpdate, planImport } from "../lib/backup";
import type { DeckUpdatePlan } from "../lib/backup";
import type { Deck } from "../lib/schemas";
import { EMPTY_TEMPLATE, type DeckTemplate } from "../lib/templates";
import { faceColors, pieceName } from "../lib/cube";
import { DEFAULT_PROFILE, planSchemeUpdate, type MemoProfile, type SchemeUpdatePlan } from "../lib/scheme";
import { SchemeWizard } from "./Onboarding";
import { ask, confirmAction, errorMessage, formatAgo, Icon, plural, toast } from "./common";
import { store, useStore } from "./store";

export function Settings() {
  useStore();
  const settings = store.settings!;
  const [decks, setDecks] = useState<Deck[]>([]);
  useEffect(() => {
    void store.repo.listDecks().then(setDecks);
  }, [store.version]);

  const [editingScheme, setEditingScheme] = useState(false);
  const profile = store.profile;

  if (editingScheme) {
    return (
      <SchemeWizard
        initial={profile ?? DEFAULT_PROFILE}
        finishLabel="Save"
        onCancel={() => setEditingScheme(false)}
        onDone={async (next) => {
          if (await saveScheme(profile, next)) setEditingScheme(false);
        }}
      />
    );
  }

  const timer = settings.timer;
  const sec = (ms: number) => Math.round(ms / 100) / 10;
  const save = (patch: Partial<typeof settings>) => store.saveSettings({ ...settings, ...patch });
  const saveTimer = (patch: Partial<typeof timer>) => save({ timer: { ...timer, ...patch } });

  return (
    <div class="page settings">
      <h1>Settings</h1>

      <h2 class="section-label">Deck</h2>
      <div class="group">
        <label class="setting">
          <span>Active deck</span>
          <select onChange={(e) => void store.switchDeck(e.currentTarget.value)}>
            {(decks.length ? decks : [store.app.deck]).map((d) => (
              <option key={d.id} value={d.id} selected={d.id === store.app.deck.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button class="setting setting-button" onClick={() => setEditingScheme(true)}>
          <span>
            Letter scheme
            <span class="setting-sub">{profile ? describeProfile(profile) : "Not set up yet"}</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
        <button class="setting setting-button" onClick={() => void newDeck()}>
          <span>New deck</span>
          <Icon name="chevron" size={18} />
        </button>
      </div>

      <h2 class="section-label">Reviews</h2>
      <div class="group">
        <div class="setting">
          <span>Recall time</span>
          <div class="segmented" role="radiogroup" aria-label="Recall time mode">
            <button role="radio" aria-checked={timer.mode === "static"} onClick={() => saveTimer({ mode: "static" })}>
              Fixed
            </button>
            <button role="radio" aria-checked={timer.mode === "dynamic"} onClick={() => saveTimer({ mode: "dynamic" })}>
              Shorter per level
            </button>
          </div>
        </div>
        {timer.mode === "static" ? (
          <NumberSetting label="Seconds per pair" value={sec(timer.staticMs)} min={1} max={120} onSave={(v) => saveTimer({ staticMs: v * 1000 })} />
        ) : (
          <>
            <NumberSetting label="Seconds at New and Level 1" value={sec(timer.dynamicStartMs)} min={1} max={120} onSave={(v) => saveTimer({ dynamicStartMs: v * 1000 })} />
            <NumberSetting label="Seconds less per level" value={sec(timer.dynamicStepMs)} min={0} max={30} step={0.5} onSave={(v) => saveTimer({ dynamicStepMs: v * 1000 })} />
            <NumberSetting label="Never less than (seconds)" value={sec(timer.dynamicMinMs)} min={1} max={60} onSave={(v) => saveTimer({ dynamicMinMs: v * 1000 })} />
          </>
        )}
        <div class="setting">
          <span>Pairs per session</span>
          <div class="segmented" role="radiogroup" aria-label="Session size">
            <button role="radio" aria-checked={settings.sessionLimit === null} onClick={() => save({ sessionLimit: null })}>
              All due
            </button>
            <button role="radio" aria-checked={settings.sessionLimit !== null} onClick={() => save({ sessionLimit: settings.sessionLimit ?? 20 })}>
              Limit
            </button>
          </div>
        </div>
        {settings.sessionLimit !== null && (
          <NumberSetting label="Max pairs per session" value={settings.sessionLimit} min={1} max={1000} onSave={(v) => save({ sessionLimit: Math.round(v) })} />
        )}
      </div>

      <h2 class="section-label">Your data</h2>
      <p class="quiet-banner">
        Saved on this device only. Last backup: {formatAgo(settings.lastBackupAt, Date.now())}.
      </p>
      <div class="group">
        <button class="setting setting-button" onClick={() => void store.exportBackup()}>
          <span>Export backup</span>
          <Icon name="download" size={18} />
        </button>
        <button class="setting setting-button" onClick={() => void importFile()}>
          <span>Import file</span>
          <Icon name="upload" size={18} />
        </button>
      </div>

      <h2 class="section-label">App</h2>
      <div class="group">
        <div class="setting setting-text">
          <span>Install on your phone</span>
          <span class="muted">iPhone: Share, then Add to Home Screen. Android: menu, then Install app. Works offline once installed.</span>
        </div>
        <button class="setting setting-button danger" onClick={() => void resetAll()}>
          <span>Delete all data</span>
          <Icon name="trash" size={18} />
        </button>
      </div>
      {!store.durable && <p class="notice">This browser isn't letting the app save data. Anything you do will be lost on reload.</p>}
    </div>
  );
}

function NumberSetting(props: { label: string; value: number; min: number; max: number; step?: number; onSave: (v: number) => void }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = () => {
    const v = Number(text);
    if (!Number.isFinite(v) || v < props.min || v > props.max) {
      setText(String(props.value));
      toast(`Enter a number from ${props.min} to ${props.max}.`);
      return;
    }
    if (v !== props.value) props.onSave(v);
  };
  return (
    <label class="setting">
      <span>{props.label}</span>
      <input
        class="input number"
        type="number"
        inputMode="decimal"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      />
    </label>
  );
}

function describeProfile(p: MemoProfile): string {
  const colors = faceColors(p.orientation);
  return `${colors.U} top, ${colors.F} front · buffers ${pieceName("corner", p.cornerBuffer)} and ${pieceName("edge", p.edgeBuffer)}`;
}

async function newDeck(): Promise<void> {
  const profile = store.profile;
  const choice = await ask(
    "New deck",
    <p>The new deck becomes your active deck. Your other decks are kept.</p>,
    [
      { label: "Cancel", value: null, tone: "plain" },
      { label: "Empty", value: "empty" as const, tone: "plain" },
      ...(profile ? [{ label: "All my letter pairs", value: "scheme" as const, tone: "primary" as const }] : []),
    ],
  );
  if (choice === "empty") await store.startFromTemplate(EMPTY_TEMPLATE);
  if (choice === "scheme" && profile) await store.createDeckFromProfile(profile);
}

/** Save a changed scheme, previewing what happens to the active deck. Returns false if cancelled. */
async function saveScheme(before: MemoProfile | null, after: MemoProfile): Promise<boolean> {
  const plan = planSchemeUpdate(store.app.deck, before, after);
  const nothingChanges = !plan.renamed.length && !plan.added.length && !plan.missing.length;
  if (nothingChanges) {
    await store.applySchemeChange(after, plan, false);
    toast("Letter scheme saved");
    return true;
  }

  let removeMissing = false;
  if (plan.missing.length) {
    const choice = await ask(
      `${plural(plan.missing.length, "pair isn't", "pairs aren't")} in the new scheme`,
      <p>{listTerms(plan.missing)}. Keep them in your deck, or remove them along with their progress?</p>,
      [
        { label: "Cancel", value: null, tone: "plain" },
        { label: "Remove", value: true, tone: "danger" },
        { label: "Keep", value: false, tone: "primary" },
      ],
    );
    if (choice === null) return false;
    removeMissing = choice;
  }
  const ok = await confirmAction(
    `Update “${store.app.deck.name}”?`,
    <SchemePreview plan={plan} removeMissing={removeMissing} />,
    "Save scheme",
  );
  if (!ok) return false;
  await store.applySchemeChange(after, plan, removeMissing);
  toast("Letter scheme saved");
  return true;
}

function SchemePreview({ plan, removeMissing }: { plan: SchemeUpdatePlan; removeMissing: boolean }) {
  return (
    <div class="preview">
      <ul>
        {plan.renamed.length > 0 && (
          <li>
            {plural(plan.renamed.length, "pair")} renamed, keeping answers and progress:{" "}
            {listTerms(plan.renamed.map((r) => `${r.from} → ${r.to}`))}
          </li>
        )}
        {plan.added.length > 0 && <li>{plural(plan.added.length, "new pair")}, no answers yet: {listTerms(plan.added)}</li>}
        {plan.missing.length > 0 && (
          <li>
            {plural(plan.missing.length, "pair")} {removeMissing ? "removed" : "kept, though the scheme doesn't need them"}:{" "}
            {listTerms(plan.missing)}
          </li>
        )}
      </ul>
    </div>
  );
}

async function resetAll(): Promise<void> {
  const ok = await confirmAction(
    "Delete all data?",
    <p>Every deck, your progress and history will be deleted from this device. Export a backup first if you might want them back.</p>,
    "Delete everything",
    true,
  );
  if (ok) await store.resetAll();
}

/** Import flow: backups restore decks; deck lists update the current deck or become a new one. */
export async function importFile(): Promise<void> {
  try {
    const file = await pickTextFile();
    if (!file) return;
    const source = parseImport(file.text, file.name);
    const active = store.status.kind === "ready" ? store.app.deck : null;

    if (source.kind === "deck-list" && active) {
      const choice = await ask(
        "Import deck list",
        <p>Update your current deck “{active.name}” from this file, or import it as a separate deck?</p>,
        [
          { label: "Cancel", value: null, tone: "plain" },
          { label: "New deck", value: "new", tone: "plain" },
          { label: "Update current", value: "update", tone: "primary" },
        ],
      );
      if (choice === null) return;
      if (choice === "update") return await updateDeck(active, source.template);
    }

    const plan = await planImport(store.repo, source, Date.now());
    const conflicts = plan.filter((e) => e.existing);
    let policy: "replace" | "copy" | "skip" = "replace";
    if (conflicts.length) {
      const names = conflicts.map((e) => e.bundle.deck.name).join(", ");
      const choice = await ask(
        `${names} already ${conflicts.length === 1 ? "exists" : "exist"}`,
        <p>Replace it with the version from the file (current progress for it is lost), keep both, or skip it?</p>,
        [
          { label: "Skip", value: "skip" as const, tone: "plain" },
          { label: "Keep both", value: "copy" as const, tone: "plain" },
          { label: "Replace", value: "replace" as const, tone: "danger" },
        ],
      );
      if (choice === null) return;
      policy = choice;
    }
    const count = await store.applyImport(plan, policy);
    toast(count ? `Imported ${plural(count, "deck")}` : "Nothing imported");
  } catch (error) {
    toast(error instanceof ImportError ? error.message : `Couldn't import: ${errorMessage(error)}`);
  }
}

async function updateDeck(deck: Deck, list: DeckTemplate): Promise<void> {
  const plan = planDeckUpdate(deck, list);
  let removeMissing = false;
  if (plan.missingTerms.length) {
    const choice = await ask(
      `${plural(plan.missingTerms.length, "pair isn't", "pairs aren't")} in the file`,
      <p>{listTerms(plan.missingTerms)}. Keep them in your deck, or remove them along with their progress?</p>,
      [
        { label: "Cancel", value: null, tone: "plain" },
        { label: "Remove", value: true, tone: "danger" },
        { label: "Keep", value: false, tone: "primary" },
      ],
    );
    if (choice === null) return;
    removeMissing = choice;
  }
  const opts = { removeMissing };
  if (!deckUpdateHasChanges(plan, opts)) return toast(`“${deck.name}” already matches this file`);
  const ok = await confirmAction(`Update “${deck.name}”?`, <UpdatePreview plan={plan} removeMissing={removeMissing} />, "Update deck");
  if (!ok) return;
  await store.applyDeckUpdate(deck.id, list, opts);
  toast(`Updated “${deck.name}”`);
}

function listTerms(terms: string[], max = 10): string {
  return terms.slice(0, max).join(", ") + (terms.length > max ? `, and ${terms.length - max} more` : "");
}

function UpdatePreview({ plan, removeMissing }: { plan: DeckUpdatePlan; removeMissing: boolean }) {
  const gained = plan.changed.filter((c) => c.added.length);
  const lost = plan.changed.filter((c) => c.removed.length);
  return (
    <div class="preview">
      <ul>
        {plan.addedTerms.length > 0 && <li>{plural(plan.addedTerms.length, "new pair")}: {listTerms(plan.addedTerms)}</li>}
        {gained.length > 0 && <li>New answers for {listTerms(gained.map((c) => c.term))}</li>}
        {removeMissing && plan.missingTerms.length > 0 && (
          <li>{plural(plan.missingTerms.length, "pair")} removed: {listTerms(plan.missingTerms)}</li>
        )}
      </ul>
      {lost.length > 0 && (
        <div class="warn-box">
          <strong>These answers will disappear</strong>
          <ul>
            {lost.slice(0, 10).map((c) => (
              <li key={c.term}>
                {c.term}: {c.removed.map((a) => `“${a}”`).join(", ")}
              </li>
            ))}
            {lost.length > 10 && <li>…and {plural(lost.length - 10, "more pair")}</li>}
          </ul>
        </div>
      )}
      <p class="muted">Progress is kept for every pair that stays.</p>
    </div>
  );
}
