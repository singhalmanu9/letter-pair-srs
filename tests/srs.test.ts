import { describe, expect, it } from "vitest";
import { burnedStage, isBurned, nextDueAt, stageAfterFail, stageAfterPass, stageName } from "../src/lib/srs";
import { config, DAY, HOUR } from "./helpers";

const srs = config.srs;

describe("WaniKani schedule", () => {
  it("has 8 learning stages, burned at 9", () => {
    expect(srs.stages).toHaveLength(8);
    expect(burnedStage(srs)).toBe(9);
  });

  it("passes climb one stage at a time up to burned", () => {
    const stages = [0];
    while (!isBurned(stages.at(-1)!, srs)) stages.push(stageAfterPass(stages.at(-1)!, srs));
    expect(stages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(stageAfterPass(9, srs)).toBe(9);
  });

  it("waits the WaniKani interval after reaching each stage", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => nextDueAt(s, 0, srs));
    expect(waits).toEqual([4 * HOUR, 8 * HOUR, 1 * DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 120 * DAY]);
  });

  it("new pairs are due immediately and burned pairs never", () => {
    expect(nextDueAt(0, 1234, srs)).toBe(1234);
    expect(nextDueAt(9, 1234, srs)).toBeNull();
  });

  it("apprentice fails drop one stage, never below Apprentice 1", () => {
    expect(stageAfterFail(0, srs)).toBe(1);
    expect(stageAfterFail(1, srs)).toBe(1);
    expect(stageAfterFail(2, srs)).toBe(1);
    expect(stageAfterFail(4, srs)).toBe(3);
  });

  it("guru and above fails drop two stages", () => {
    expect(stageAfterFail(5, srs)).toBe(3);
    expect(stageAfterFail(6, srs)).toBe(4);
    expect(stageAfterFail(7, srs)).toBe(5);
    expect(stageAfterFail(8, srs)).toBe(6);
  });

  it("names stages", () => {
    expect(stageName(0, srs)).toBe("New");
    expect(stageName(1, srs)).toBe("Apprentice 1");
    expect(stageName(5, srs)).toBe("Guru 1");
    expect(stageName(8, srs)).toBe("Enlightened");
    expect(stageName(9, srs)).toBe("Burned");
  });
});
