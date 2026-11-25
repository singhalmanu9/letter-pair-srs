/**
 * Letter scheme setup: orientation, letters on a cube net, buffers, then a
 * quick screen to fill in the pairs you already have. The same pieces are
 * reused in Settings to change the scheme later.
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  COLORS,
  faceColors,
  frontOptions,
  pieceIndexOf,
  pieceName,
  piecesOf,
  SPEFFZ,
  type Color,
  type Face,
  type PieceType,
} from "../lib/cube";
import {
  cleanLetter,
  DEFAULT_PROFILE,
  generatePairTerms,
  lettersFor,
  newCharacter,
  profileProblems,
  type MemoProfile,
} from "../lib/scheme";
import { hasAnswers } from "../lib/schemas";
import { plural } from "./common";
import { store, useStore } from "./store";

// --- Cube net ----------------------------------------------------------------------

/** Where each face sits in the 4x3 net (column, row), in face units. */
const NET: Record<Face, [number, number]> = { U: [1, 0], L: [0, 1], F: [1, 1], R: [2, 1], B: [3, 1], D: [1, 2] };
/** Clockwise from top-left: grid cell (col, row) of each corner and edge slot within a face. */
const CORNER_CELLS: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
const EDGE_CELLS: [number, number][] = [[1, 0], [2, 1], [1, 2], [0, 1]];
const FACE_ORDER: Face[] = ["U", "L", "F", "R", "B", "D"];

export interface StickerRef {
  type: PieceType;
  index: number;
}

export function CubeNet(props: {
  profile: MemoProfile;
  selected?: StickerRef | null;
  onSelect?: (s: StickerRef) => void;
  /** Dim the buffer pieces. */
  showBuffers?: boolean;
}) {
  const { profile, selected, onSelect, showBuffers } = props;
  const colors = faceColors(profile.orientation);
  const cells: preact.JSX.Element[] = [];

  FACE_ORDER.forEach((face, f) => {
    const [fc, fr] = NET[face];
    const place = (c: number, r: number) => ({ gridColumn: fc * 3 + c + 1, gridRow: fr * 3 + r + 1 });
    cells.push(
      <div key={`${face}-c`} class={`sticker face-center c-${colors[face]}`} style={place(1, 1)}>
        {face}
      </div>,
    );
    for (const type of ["corner", "edge"] as const) {
      (type === "corner" ? CORNER_CELLS : EDGE_CELLS).forEach(([c, r], slot) => {
        const index = f * 4 + slot;
        const letter = lettersFor(profile, type)[index] ?? "";
        const buffer = type === "corner" ? profile.cornerBuffer : profile.edgeBuffer;
        const isBuffer = showBuffers && pieceIndexOf(type, index) === buffer;
        const isSelected = selected?.type === type && selected.index === index;
        cells.push(
          <button
            key={`${type}-${index}`}
            type="button"
            class={`sticker c-${colors[face]} ${isSelected ? "selected" : ""} ${isBuffer ? "buffer" : ""}`}
            style={place(c, r)}
            onClick={() => onSelect?.({ type, index })}
            disabled={!onSelect}
            aria-label={`${type} sticker ${index + 1} on the ${face} face: ${letter || "no letter"}`}
          >
            {letter}
          </button>,
        );
      });
    }
  });
  return <div class="cube-net">{cells}</div>;
}

// --- Steps ---------------------------------------------------------------------

function OrientationStep({ profile, onChange }: { profile: MemoProfile; onChange: (p: MemoProfile) => void }) {
  const { top, front } = profile.orientation;
  const setTop = (c: Color) => {
    const fronts = frontOptions(c);
    onChange({ ...profile, orientation: { top: c, front: fronts.includes(front) ? front : fronts[0]! } });
  };
  return (
    <>
      <p class="muted">How do you hold the cube when you memo? Scramble orientation is white top, green front.</p>
      <h3 class="section-label">Top</h3>
      <ColorChoice options={COLORS} value={top} onPick={setTop} />
      <h3 class="section-label">Front</h3>
      <ColorChoice options={frontOptions(top)} value={front} onPick={(c) => onChange({ ...profile, orientation: { top, front: c } })} />
      <CubeNet profile={profile} />
    </>
  );
}

function ColorChoice({ options, value, onPick }: { options: readonly Color[]; value: Color; onPick: (c: Color) => void }) {
  return (
    <div class="color-choice" role="radiogroup">
      {options.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} class={`color-dot c-${c}`} onClick={() => onPick(c)}>
          <span class="sr-only">{c}</span>
        </button>
      ))}
    </div>
  );
}

function LettersStep({ profile, onChange }: { profile: MemoProfile; onChange: (p: MemoProfile) => void }) {
  const [selected, setSelected] = useState<StickerRef | null>({ type: "corner", index: 0 });
  const [editing, setEditing] = useState<PieceType>("corner");
  const inputRef = useRef<HTMLInputElement>(null);
  const problems = profileProblems(profile);

  useEffect(() => inputRef.current?.focus(), [selected]);

  const setLetter = (value: string) => {
    if (!selected) return;
    const letter = cleanLetter(value);
    if (!letter) return;
    const key = selected.type === "edge" && !profile.sameLetters ? "edgeLetters" : "cornerLetters";
    const next = [...profile[key]];
    next[selected.index] = letter;
    onChange({ ...profile, [key]: next });
    // Move on to the next sticker of the same type, Speffz order.
    setSelected({ type: selected.type, index: (selected.index + 1) % 24 });
  };

  const select = (s: StickerRef) => {
    setSelected(s);
    if (!profile.sameLetters) setEditing(s.type);
  };

  const current = selected ? lettersFor(profile, selected.type)[selected.index] : "";
  return (
    <>
      <p class="muted">
        Tap a sticker and type its letter. Letters start as Speffz. Change any you use differently, like if you don't
        use K or Q.
      </p>
      <label class="setting toggle-row">
        <span>Same letters for corners and edges</span>
        <input
          type="checkbox"
          checked={profile.sameLetters}
          onChange={(e) => onChange({ ...profile, sameLetters: e.currentTarget.checked, edgeLetters: [...profile.cornerLetters] })}
        />
      </label>
      {!profile.sameLetters && (
        <div class="segmented" role="radiogroup">
          {(["corner", "edge"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={editing === t} onClick={() => select({ type: t, index: selected?.index ?? 0 })}>
              {t === "corner" ? "Corners" : "Edges"}
            </button>
          ))}
        </div>
      )}
      <CubeNet profile={profile} selected={selected} onSelect={select} />
      {selected && (
        <div class="letter-edit">
          <span class="muted">
            {profile.sameLetters ? "Sticker" : selected.type === "corner" ? "Corner sticker" : "Edge sticker"} on{" "}
            {pieceName(selected.type, pieceIndexOf(selected.type, selected.index))} (Speffz {SPEFFZ[selected.index]})
          </span>
          <input
            ref={inputRef}
            class="input letter-input"
            value={current}
            maxLength={3}
            autocapitalize="characters"
            autocomplete="off"
            enterkeyhint="next"
            onFocus={(e) => e.currentTarget.select()}
            onInput={(e) => setLetter(newCharacter(e.currentTarget.value, current ?? ""))}
          />
        </div>
      )}
      <button class="btn" type="button" onClick={() => onChange({ ...profile, cornerLetters: [...SPEFFZ], edgeLetters: [...SPEFFZ] })}>
        Reset to Speffz
      </button>
      {problems.map((p) => (
        <p class="field-error" key={p}>
          {p}
        </p>
      ))}
    </>
  );
}

function BuffersStep({ profile, onChange }: { profile: MemoProfile; onChange: (p: MemoProfile) => void }) {
  const count = useMemo(() => generatePairTerms(profile).length, [profile]);
  const options = (type: PieceType) =>
    piecesOf(type).map((piece, i) => ({
      i,
      label: `${pieceName(type, i)} (${piece.map((s) => lettersFor(profile, type)[s]).join(" ")})`,
    }));
  return (
    <>
      <p class="muted">Your buffers decide which letters never show up in memo.</p>
      <div class="group">
        <label class="setting">
          <span>Corner buffer</span>
          <select onChange={(e) => onChange({ ...profile, cornerBuffer: Number(e.currentTarget.value) })}>
            {options("corner").map((o) => (
              <option key={o.i} value={o.i} selected={o.i === profile.cornerBuffer}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label class="setting">
          <span>Edge buffer</span>
          <select onChange={(e) => onChange({ ...profile, edgeBuffer: Number(e.currentTarget.value) })}>
            {options("edge").map((o) => (
              <option key={o.i} value={o.i} selected={o.i === profile.edgeBuffer}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label class="setting toggle-row">
          <span>
            I also do 4BLD or 5BLD
            <span class="setting-sub">
              Adds pairs that only come up on bigger cubes, like your buffer letters on wings. They're marked 4BLD+.
            </span>
          </span>
          <input
            type="checkbox"
            checked={!profile.excludeImpossible}
            onChange={(e) => onChange({ ...profile, excludeImpossible: !e.currentTarget.checked })}
          />
        </label>
      </div>
      <CubeNet profile={profile} showBuffers />
      <p class="pair-count">That's {plural(count, "letter pair")}.</p>
    </>
  );
}

const STEPS = [
  { title: "Your orientation", Component: OrientationStep },
  { title: "Your letters", Component: LettersStep },
  { title: "Your buffers", Component: BuffersStep },
] as const;

/** Step-by-step scheme editor. `onDone` receives the finished profile. */
export function SchemeWizard(props: {
  initial: MemoProfile;
  finishLabel: string;
  onDone: (profile: MemoProfile) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [profile, setProfile] = useState(props.initial);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const { title, Component } = STEPS[step]!;
  const canContinue = step !== 1 || profileProblems(profile).length === 0;
  const last = step === STEPS.length - 1;

  return (
    <div class="page wizard">
      <p class="muted step-count">
        Step {step + 1} of {STEPS.length}
      </p>
      <h1>{title}</h1>
      <Component profile={profile} onChange={setProfile} />
      <div class="spacer" />
      <div class="row-2 wizard-nav">
        <button class="btn" type="button" onClick={() => (step === 0 ? props.onCancel() : setStep(step - 1))}>
          {step === 0 ? "Cancel" : "Back"}
        </button>
        <button
          class="btn btn-primary"
          type="button"
          disabled={!canContinue || busy}
          onClick={async () => {
            if (!last) return setStep(step + 1);
            setBusy(true);
            try {
              await props.onDone(profile);
            } finally {
              setBusy(false);
            }
          }}
        >
          {last ? props.finishLabel : "Next"}
        </button>
      </div>
    </div>
  );
}

// --- Fill in -------------------------------------------------------------------

/** Quickly add answers to pairs that have none. Skipped pairs come up in reviews. */
export function FillIn({ onDone }: { onDone: () => void }) {
  useStore();
  const { deck } = store.app;
  // Work through the pairs that were unanswered when the screen opened.
  const [queue] = useState(() => deck.items.filter((i) => !hasAnswers(i)).map((i) => i.id));
  const [position, setPosition] = useState(0);
  const [draft, setDraft] = useState("");
  const [filled, setFilled] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), [position]);

  const item = deck.items.find((i) => i.id === queue[position]);
  if (!item) {
    return (
      <div class="page center">
        <h1>{filled ? `Added answers for ${plural(filled, "pair")}` : "Nothing to fill in"}</h1>
        <p class="muted">Pairs without an answer come up in reviews. Come up with one then.</p>
        <button class="btn btn-primary btn-tall" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  const next = () => {
    setDraft("");
    setPosition(position + 1);
  };
  const save = async (e: Event) => {
    e.preventDefault();
    if (draft.trim() === "") return next();
    await store.addAnswer(item.id, draft);
    setFilled(filled + 1);
    next();
  };

  return (
    <form class="page fill-in" onSubmit={save}>
      <div class="fill-top">
        <span class="muted">
          {position + 1} of {queue.length}
        </span>
        <button type="button" class="btn" onClick={onDone}>
          Finish
        </button>
      </div>
      <p class="muted">Type the image you use for each pair. Leave it blank to skip. Skipped pairs come up in reviews.</p>
      <div class="fill-term">{item.term}</div>
      <input
        ref={inputRef}
        class="input"
        value={draft}
        placeholder="Your image"
        autocomplete="off"
        autocapitalize="words"
        enterkeyhint="next"
        onInput={(e) => setDraft(e.currentTarget.value)}
      />
      {draft.trim() ? (
        <div class="row-2">
          <button type="button" class="btn" onClick={next}>
            Skip
          </button>
          <button type="submit" class="btn btn-primary">
            Save
          </button>
        </div>
      ) : (
        // Enter on a blank field also skips (handled by submit).
        <button type="submit" class="btn">
          Skip
        </button>
      )}
    </form>
  );
}

// --- First run -------------------------------------------------------------------

export function Onboarding({ onImport, onCreated }: { onImport: () => void; onCreated: () => void }) {
  const [stage, setStage] = useState<"welcome" | "scheme">("welcome");
  if (stage === "scheme") {
    return (
      <SchemeWizard
        initial={DEFAULT_PROFILE}
        finishLabel="Create my pairs"
        onCancel={() => setStage("welcome")}
        onDone={async (profile) => {
          await store.createDeckFromProfile(profile);
          onCreated();
        }}
      />
    );
  }
  return (
    <div class="page onboarding">
      <h1>BLD Letter Pairs SRS</h1>
      <p class="muted">
        Drill your letter pair images with spaced repetition. First, tell the app how you memo: your orientation,
        letters and buffers. It'll build your list of letter pairs from that.
      </p>
      <div class="template-list">
        <button class="template" onClick={() => setStage("scheme")}>
          <span class="template-name">Set up my letters</span>
          <span class="muted">About a minute. You can change it later in Settings.</span>
        </button>
        <button class="template" onClick={onImport}>
          <span class="template-name">Import a file</span>
          <span class="muted">A backup from this app, or a list of your letter pairs.</span>
        </button>
      </div>
    </div>
  );
}
