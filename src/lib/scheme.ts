/**
 * The user's memo setup ("profile"): letters on each sticker, cube
 * orientation, buffers, and which pairs to generate. Saved in storage and used
 * to build and later update the letter-pair deck.
 */

import {
  CORNER_PIECES,
  EDGE_PIECES,
  isValidOrientation,
  pieceIndexOf,
  piecesOf,
  SCRAMBLE_ORIENTATION,
  SPEFFZ,
  STICKERS_PER_TYPE,
  type Orientation,
  type PieceType,
} from "./cube";
import { termKey, type Deck } from "./schemas";

export interface MemoProfile {
  /** Letter on each corner sticker (24, Speffz order). */
  cornerLetters: string[];
  /** Letter on each edge sticker. Ignored while `sameLetters` is true. */
  edgeLetters: string[];
  /** Corners and edges use the same letters (most people do). */
  sameLetters: boolean;
  orientation: Orientation;
  /** Buffer piece indexes (into CORNER_PIECES / EDGE_PIECES). */
  cornerBuffer: number;
  edgeBuffer: number;
  /** Leave out pairs that can never come up in memo. */
  excludeImpossible: boolean;
}

/** Speffz letters, scramble orientation, UFR and UF buffers. */
export const DEFAULT_PROFILE: MemoProfile = {
  cornerLetters: [...SPEFFZ],
  edgeLetters: [...SPEFFZ],
  sameLetters: true,
  orientation: SCRAMBLE_ORIENTATION,
  cornerBuffer: CORNER_PIECES.findIndex((p) => p.includes(2)), // UFR (C J M)
  edgeBuffer: EDGE_PIECES.findIndex((p) => p.includes(2)), // UF (C I)
  excludeImpossible: true,
};

export function lettersFor(profile: MemoProfile, type: PieceType): string[] {
  return type === "edge" && !profile.sameLetters ? profile.edgeLetters : profile.cornerLetters;
}

/** Normalize a typed letter: trimmed, uppercased, one character. Empty if blank. */
export function cleanLetter(value: string): string {
  return [...value.trim().toUpperCase()][0] ?? "";
}

/**
 * The character the user just typed into a field that held `old`. The cursor
 * can be anywhere (selection isn't reliable on phones), so remove one copy of
 * the old letter and take what's left.
 */
export function newCharacter(value: string, old: string): string {
  if (value.length <= 1) return value;
  const i = old ? value.indexOf(old) : -1;
  return i >= 0 ? value.slice(0, i) + value.slice(i + old.length) : value.slice(-1);
}

/** Problems with a set of letters, or [] if it's fine. */
export function letterProblems(letters: readonly string[]): string[] {
  const problems: string[] = [];
  if (letters.length !== STICKERS_PER_TYPE) problems.push(`Expected ${STICKERS_PER_TYPE} letters.`);
  if (letters.some((l) => l.trim() === "")) problems.push("Every sticker needs a letter.");
  const seen = new Map<string, number>();
  for (const l of letters) seen.set(termKey(l), (seen.get(termKey(l)) ?? 0) + 1);
  const dupes = [...seen].filter(([l, n]) => l && n > 1).map(([l]) => l);
  if (dupes.length) problems.push(`Used on more than one sticker: ${dupes.join(", ")}.`);
  return problems;
}

/** Problems with the whole profile, or [] if it can be saved. */
export function profileProblems(p: MemoProfile): string[] {
  const problems = letterProblems(p.cornerLetters).map((m) => `Corners: ${m}`);
  if (!p.sameLetters) problems.push(...letterProblems(p.edgeLetters).map((m) => `Edges: ${m}`));
  if (!isValidOrientation(p.orientation)) problems.push("Pick a front color that sits next to the top color.");
  return problems;
}

/** Ordered letter pairs (as terms like "AB") that can come up for one piece type. */
function pairsFor(profile: MemoProfile, type: PieceType): Set<string> {
  const letters = lettersFor(profile, type);
  const buffer = type === "corner" ? profile.cornerBuffer : profile.edgeBuffer;
  const pairs = new Set<string>();
  for (let a = 0; a < STICKERS_PER_TYPE; a++) {
    for (let b = 0; b < STICKERS_PER_TYPE; b++) {
      if (profile.excludeImpossible) {
        const pa = pieceIndexOf(type, a);
        const pb = pieceIndexOf(type, b);
        // Same sticker twice, two stickers of one piece, or the buffer piece.
        if (pa === pb || pa === buffer || pb === buffer) continue;
      } else if (letters[a] === letters[b]) continue;
      pairs.add(letters[a]! + letters[b]!);
    }
  }
  return pairs;
}

/**
 * All pair terms for the profile, as one list shared by corners and edges:
 * a pair is included if it can come up for either piece type. Sorted.
 */
export function generatePairTerms(profile: MemoProfile): string[] {
  const all = new Set([...pairsFor(profile, "corner"), ...pairsFor(profile, "edge")]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/**
 * Pairs in the profile's list that can only come up on bigger cubes: on wings
 * and centers every sticker is its own piece and the buffers differ, so pairs
 * a 3x3 never needs can show up. Empty unless the profile includes them.
 */
export function bigCubeOnlyTerms(profile: MemoProfile): Set<string> {
  if (profile.excludeImpossible) return new Set();
  const small = new Set(generatePairTerms({ ...profile, excludeImpossible: true }).map(termKey));
  return new Set(generatePairTerms(profile).map(termKey).filter((t) => !small.has(t)));
}

// --- Changing the scheme later ---------------------------------------------

/**
 * Letter renames implied by a scheme change: old letter -> new letter, for
 * letters that moved consistently (every sticker that had the old letter now
 * has the same new one). Pairs using those letters are renamed, keeping their
 * answers and progress.
 */
export function letterRenames(before: MemoProfile, after: MemoProfile): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const type of ["corner", "edge"] as const) {
    const old = lettersFor(before, type);
    const next = lettersFor(after, type);
    old.forEach((l, i) => {
      const set = candidates.get(l) ?? new Set();
      set.add(next[i]!);
      candidates.set(l, set);
    });
  }
  const renames = new Map<string, string>();
  for (const [from, targets] of candidates) {
    const [to] = [...targets];
    if (targets.size === 1 && to !== from) renames.set(from, to!);
  }
  return renames;
}

export interface SchemeUpdatePlan {
  /** Existing pairs whose letters change, keeping answers and progress. */
  renamed: { from: string; to: string }[];
  /** New pairs to add (no answers yet). */
  added: string[];
  /** Pairs in the deck that the new scheme doesn't generate. */
  missing: string[];
}

/** Compare a deck with what a new profile generates. Pure. */
export function planSchemeUpdate(deck: Deck, before: MemoProfile | null, after: MemoProfile): SchemeUpdatePlan {
  const renames = before ? letterRenames(before, after) : new Map<string, string>();
  const rename = (term: string) => [...term].map((ch) => renames.get(ch) ?? ch).join("");
  const target = new Set(generatePairTerms(after).map(termKey));

  const renamed: SchemeUpdatePlan["renamed"] = [];
  const kept = new Set<string>();
  const missing: string[] = [];
  for (const item of deck.items) {
    const to = rename(item.term);
    if (to !== item.term && target.has(termKey(to))) renamed.push({ from: item.term, to });
    if (target.has(termKey(to))) kept.add(termKey(to));
    else missing.push(item.term);
  }
  const added = generatePairTerms(after).filter((t) => !kept.has(termKey(t)));
  return { renamed, added, missing };
}

/**
 * Apply a scheme update to a deck (returns a new deck): rename, add new pairs
 * without answers, and remove missing pairs only if asked.
 */
export function applySchemeUpdate(
  deck: Deck,
  plan: SchemeUpdatePlan,
  removeMissing: boolean,
  now: number,
  newId: () => string = () => crypto.randomUUID(),
): Deck {
  const renameTo = new Map(plan.renamed.map((r) => [r.from, r.to]));
  const missing = new Set(plan.missing);
  const items = deck.items
    .filter((i) => !(removeMissing && missing.has(i.term)))
    .map((i) => (renameTo.has(i.term) ? { ...i, term: renameTo.get(i.term)!, updatedAt: now } : i));
  for (const term of plan.added) items.push({ id: newId(), term, answers: [], updatedAt: now });
  items.sort((a, b) => a.term.localeCompare(b.term));
  return { ...deck, items, updatedAt: now };
}

// --- Storage parsing -----------------------------------------------------------

export function parseProfile(value: unknown): MemoProfile {
  if (typeof value !== "object" || value === null) throw new Error("profile must be an object");
  const o = value as Record<string, unknown>;
  const letters = (v: unknown, name: string) => {
    if (!Array.isArray(v) || v.length !== STICKERS_PER_TYPE || !v.every((l) => typeof l === "string" && cleanLetter(l))) {
      throw new Error(`profile.${name} must be ${STICKERS_PER_TYPE} letters`);
    }
    return v.map((l: string) => cleanLetter(l));
  };
  const orientation = o.orientation as Orientation;
  if (!orientation || !isValidOrientation(orientation)) throw new Error("profile.orientation is invalid");
  const piece = (v: unknown, type: PieceType) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= piecesOf(type).length) {
      throw new Error(`profile.${type}Buffer is invalid`);
    }
    return v;
  };
  return {
    cornerLetters: letters(o.cornerLetters, "cornerLetters"),
    edgeLetters: letters(o.edgeLetters, "edgeLetters"),
    sameLetters: o.sameLetters !== false,
    orientation: { top: orientation.top, front: orientation.front },
    cornerBuffer: piece(o.cornerBuffer, "corner"),
    edgeBuffer: piece(o.edgeBuffer, "edge"),
    excludeImpossible: o.excludeImpossible !== false,
  };
}
