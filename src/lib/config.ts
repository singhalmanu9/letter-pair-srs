/** App settings and defaults. All durations are in milliseconds. */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface SrsStage {
  /** How long a pair waits before its next review after reaching this stage. */
  intervalMs: number;
}

export interface SrsConfig {
  /**
   * Review stages in order. A pair's stage number is 0 when it is new (due
   * immediately), 1..stages.length while it is being learned, and
   * stages.length + 1 once it is burned (never reviewed again). Stages are
   * shown as "Level <n>", so with 8 stages the burned level is Level 9.
   */
  stages: readonly SrsStage[];
  /** Stage number from which a fail drops two stages instead of one. */
  heavyPenaltyFromStage: number;
}

export type TimerMode = "static" | "dynamic";

/**
 * Recall time per pair. Static: the same for every pair. Dynamic: starts at
 * `dynamicStartMs` for New and Level 1 pairs and shrinks by `dynamicStepMs`
 * per level above 1, never below `dynamicMinMs`.
 */
export interface TimerConfig {
  mode: TimerMode;
  staticMs: number;
  dynamicStartMs: number;
  dynamicStepMs: number;
  dynamicMinMs: number;
}

export interface AppConfig {
  timer: TimerConfig;
  srs: SrsConfig;
  /** Max pairs per review session, or null to review everything due. */
  sessionLimit: number | null;
}

/** WaniKani's fixed schedule, as Levels 1-8 (Level 9 = burned). */
export const WANIKANI_SRS: SrsConfig = {
  stages: [
    { intervalMs: 4 * HOUR }, // Level 1
    { intervalMs: 8 * HOUR }, // Level 2
    { intervalMs: 1 * DAY }, // Level 3
    { intervalMs: 2 * DAY }, // Level 4
    { intervalMs: 7 * DAY }, // Level 5
    { intervalMs: 14 * DAY }, // Level 6
    { intervalMs: 30 * DAY }, // Level 7
    { intervalMs: 120 * DAY }, // Level 8
  ],
  // Level 5 and above drop two levels on a fail; Levels 1-4 drop one.
  heavyPenaltyFromStage: 5,
};

export const DEFAULT_TIMER: TimerConfig = {
  mode: "static",
  staticMs: 10_000,
  dynamicStartMs: 10_000,
  dynamicStepMs: 1_000,
  dynamicMinMs: 2_000,
};

export const DEFAULT_CONFIG: AppConfig = {
  timer: DEFAULT_TIMER,
  srs: WANIKANI_SRS,
  sessionLimit: null,
};

/** Recall time for a pair at `stage` under the given timer settings. */
export function timeoutForStage(stage: number, timer: TimerConfig): number {
  if (timer.mode === "static") return timer.staticMs;
  const shrink = timer.dynamicStepMs * Math.max(0, stage - 1);
  return Math.max(timer.dynamicMinMs, timer.dynamicStartMs - shrink);
}
