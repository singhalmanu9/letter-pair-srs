import { describe, expect, it } from "vitest";
import {
  CORNER_PIECES,
  EDGE_PIECES,
  faceColors,
  frontOptions,
  isValidOrientation,
  pieceName,
  SPEFFZ,
} from "../src/lib/cube";
import { MemoryStore } from "../src/lib/storage";
import { Repository } from "../src/lib/repository";
import {
  applySchemeUpdate,
  bigCubeOnlyTerms,
  cleanLetter,
  DEFAULT_PROFILE,
  generatePairTerms,
  letterProblems,
  letterRenames,
  newCharacter,
  parseProfile,
  planSchemeUpdate,
  profileProblems,
  type MemoProfile,
} from "../src/lib/scheme";
import type { Deck } from "../src/lib/schemas";

const withLetter = (profile: MemoProfile, from: string, to: string): MemoProfile => ({
  ...profile,
  cornerLetters: profile.cornerLetters.map((l) => (l === from ? to : l)),
  edgeLetters: profile.edgeLetters.map((l) => (l === from ? to : l)),
});

const deckOf = (terms: string[], answers: Record<string, string[]> = {}): Deck => ({
  id: "d",
  name: "Mine",
  templateId: "scheme",
  createdAt: 0,
  updatedAt: 0,
  items: terms.map((term, i) => ({ id: `id${i}`, term, answers: answers[term] ?? [], updatedAt: 0 })),
});

describe("cube model", () => {
  it("every sticker belongs to exactly one piece", () => {
    for (const pieces of [CORNER_PIECES, EDGE_PIECES]) {
      const all = pieces.flat().sort((a, b) => a - b);
      expect(all).toEqual([...Array(24).keys()]);
    }
  });

  it("matches Speffz pieces", () => {
    const letters = (piece: readonly number[]) => piece.map((i) => SPEFFZ[i]).sort().join("");
    expect(CORNER_PIECES.map(letters)).toEqual(["AER", "BNQ", "CJM", "DFI", "GLU", "KPV", "OTW", "HSX"]);
    expect(EDGE_PIECES.map(letters)).toEqual(["AQ", "BM", "CI", "DE", "FL", "GX", "HR", "JP", "KU", "NT", "OV", "SW"]);
  });

  it("names pieces", () => {
    expect(pieceName("corner", DEFAULT_PROFILE.cornerBuffer)).toBe("UFR");
    expect(pieceName("edge", DEFAULT_PROFILE.edgeBuffer)).toBe("UF");
    expect(pieceName("corner", 7)).toBe("DBL");
  });

  it("works out face colors for an orientation", () => {
    expect(faceColors({ top: "white", front: "green" })).toEqual({
      U: "white", D: "yellow", F: "green", B: "blue", R: "red", L: "orange",
    });
    expect(faceColors({ top: "yellow", front: "orange" })).toMatchObject({ R: "blue", L: "green", D: "white" });
  });

  it("only allows a front color next to the top color", () => {
    expect(frontOptions("white").sort()).toEqual(["blue", "green", "orange", "red"]);
    expect(isValidOrientation({ top: "white", front: "yellow" })).toBe(false);
    expect(() => faceColors({ top: "red", front: "orange" })).toThrow();
  });
});

describe("pair generation", () => {
  it("default Speffz with impossible pairs left out", () => {
    const terms = generatePairTerms(DEFAULT_PROFILE);
    expect(terms.length).toBeLessThan(24 * 23);
    expect(terms.some((t) => t[0] === t[1])).toBe(false);
    expect(terms.some((t) => t.includes("C"))).toBe(false); // C is on both buffers
    expect(terms).not.toContain("FI"); // same corner, and I is the edge buffer
    expect(terms).toContain("AQ"); // same edge, but fine as corners
    expect(terms).toContain("AJ"); // J is the corner buffer, but fine as edges
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("all 552 pairs when impossible pairs are kept", () => {
    expect(generatePairTerms({ ...DEFAULT_PROFILE, excludeImpossible: false })).toHaveLength(552);
  });

  it("uses the user's letters", () => {
    const terms = generatePairTerms(withLetter(DEFAULT_PROFILE, "K", "Y"));
    expect(terms.some((t) => t.includes("K"))).toBe(false);
    expect(terms).toContain("AY");
  });

  it("separate edge letters only change the edge pairs", () => {
    const profile = { ...DEFAULT_PROFILE, sameLetters: false, edgeLetters: SPEFFZ.map((l) => (l === "K" ? "Z" : l)) };
    const terms = generatePairTerms(profile);
    expect(terms).toContain("AZ"); // edge FD
    expect(terms).toContain("AK"); // corner DFR still K
  });
});

describe("validation", () => {
  it("cleans typed letters", () => {
    expect(cleanLetter(" y ")).toBe("Y");
    expect(cleanLetter("ab")).toBe("A");
    expect(cleanLetter("  ")).toBe("");
  });

  it("finds the newly typed character wherever the cursor was", () => {
    expect(newCharacter("Y", "K")).toBe("Y");
    expect(newCharacter("KY", "K")).toBe("Y");
    expect(newCharacter("YK", "K")).toBe("Y");
    expect(newCharacter("KK", "K")).toBe("K");
    expect(newCharacter("ab", "")).toBe("b");
  });

  it("flags blank and duplicate letters", () => {
    expect(letterProblems(SPEFFZ)).toEqual([]);
    expect(letterProblems(SPEFFZ.map((l) => (l === "B" ? "A" : l)))).toEqual(["Used on more than one sticker: A."]);
    expect(letterProblems(SPEFFZ.map((l) => (l === "B" ? "" : l)))[0]).toMatch(/needs a letter/);
  });

  it("ignores edge letters while they're shared with corners", () => {
    expect(profileProblems({ ...DEFAULT_PROFILE, edgeLetters: SPEFFZ.map(() => "A") })).toEqual([]);
    expect(profileProblems({ ...DEFAULT_PROFILE, sameLetters: false, edgeLetters: SPEFFZ.map(() => "A") })).not.toEqual([]);
  });

  it("profile round-trips through storage and rejects bad data", async () => {
    const repo = new Repository(new MemoryStore());
    await repo.init();
    expect(await repo.getProfile()).toBeNull();
    const custom = { ...withLetter(DEFAULT_PROFILE, "K", "Y"), orientation: { top: "yellow" as const, front: "orange" as const } };
    await repo.saveProfile(custom);
    expect(await repo.getProfile()).toEqual(custom);

    await expect(repo.saveProfile({ ...DEFAULT_PROFILE, orientation: { top: "white", front: "yellow" } })).rejects.toThrow();
    expect(() => parseProfile({ ...DEFAULT_PROFILE, cornerLetters: ["A"] })).toThrow();
  });
});

describe("changing the scheme", () => {
  it("detects consistent letter renames", () => {
    expect(letterRenames(DEFAULT_PROFILE, withLetter(DEFAULT_PROFILE, "K", "Y"))).toEqual(new Map([["K", "Y"]]));
    const swapped = withLetter(withLetter(withLetter(DEFAULT_PROFILE, "A", "#"), "B", "A"), "#", "B");
    expect(letterRenames(DEFAULT_PROFILE, swapped)).toEqual(new Map([["A", "B"], ["B", "A"]]));
  });

  it("renaming a letter renames its pairs and keeps their answers", () => {
    const deck = deckOf(generatePairTerms(DEFAULT_PROFILE), { AK: ["Ark"] });
    const after = withLetter(DEFAULT_PROFILE, "K", "Y");
    const plan = planSchemeUpdate(deck, DEFAULT_PROFILE, after);

    expect(plan.added).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.renamed).toContainEqual({ from: "AK", to: "AY" });

    const updated = applySchemeUpdate(deck, plan, false, 99);
    const ay = updated.items.find((i) => i.term === "AY")!;
    expect(ay).toMatchObject({ id: deck.items.find((i) => i.term === "AK")!.id, answers: ["Ark"] });
    expect(updated.items.map((i) => i.term)).toEqual(generatePairTerms(after));
  });

  it("keeping impossible pairs adds them; leaving them out reports them as missing", () => {
    const deck = deckOf(generatePairTerms(DEFAULT_PROFILE));
    const all = { ...DEFAULT_PROFILE, excludeImpossible: false };
    const addPlan = planSchemeUpdate(deck, DEFAULT_PROFILE, all);
    expect(addPlan.added).toContain("CA");
    expect(addPlan.missing).toEqual([]);

    const fullDeck = applySchemeUpdate(deck, addPlan, false, 1);
    const removePlan = planSchemeUpdate(fullDeck, all, DEFAULT_PROFILE);
    expect(removePlan.missing).toContain("CA");
    expect(applySchemeUpdate(fullDeck, removePlan, false, 2).items).toHaveLength(fullDeck.items.length);
    expect(applySchemeUpdate(fullDeck, removePlan, true, 2).items).toHaveLength(deck.items.length);
  });

  it("works on a deck that didn't come from a scheme", () => {
    const deck = deckOf(["AB", "ZZ"], { AB: ["Abbey"] });
    const plan = planSchemeUpdate(deck, null, DEFAULT_PROFILE);
    expect(plan.missing).toEqual(["ZZ"]);
    expect(plan.added).not.toContain("AB");
  });
});

describe("big cube pairs", () => {
  it("are empty for 3BLD-only profiles", () => {
    expect(bigCubeOnlyTerms(DEFAULT_PROFILE).size).toBe(0);
  });

  it("are the extra pairs a big-cube profile adds, like buffer letters", () => {
    const big = { ...DEFAULT_PROFILE, excludeImpossible: false };
    const extra = bigCubeOnlyTerms(big);
    expect(extra.size).toBe(generatePairTerms(big).length - generatePairTerms(DEFAULT_PROFILE).length);
    expect(extra.has("CA")).toBe(true);
    expect(extra.has("AB")).toBe(false);
    expect(extra.has("AA")).toBe(false);
  });
});
