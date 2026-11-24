/** App settings and defaults. All durations are in milliseconds. */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface SrsStage {
  /** Display name, e.g. "Apprentice 2". */
  name: string;
  /** Display group, e.g. "Apprentice". */
  group: string;
  /** How long a pair waits before its next review after reaching this stage. */
  intervalMs: number;
}

export interface SrsConfig {
  /**
   * Review stages in order. A pair's stage number is 0 when it is new (due
   * immediately), 1..stages.length while it is being learned, and
   * stages.length + 1 once it is burned (never reviewed again).
   */
  stages: readonly SrsStage[];
  /** Stage number from which a fail drops two stages instead of one. */
  heavyPenaltyFromStage: number;
}

export interface AppConfig {
  /** Time allowed to recall a pair before it auto-fails. */
  timeoutMs: number;
  srs: SrsConfig;
  shortcuts: { reveal: string; pass: string; fail: string; next: string };
}

/** WaniKani's fixed schedule. */
export const WANIKANI_SRS: SrsConfig = {
  stages: [
    { name: "Apprentice 1", group: "Apprentice", intervalMs: 4 * HOUR },
    { name: "Apprentice 2", group: "Apprentice", intervalMs: 8 * HOUR },
    { name: "Apprentice 3", group: "Apprentice", intervalMs: 1 * DAY },
    { name: "Apprentice 4", group: "Apprentice", intervalMs: 2 * DAY },
    { name: "Guru 1", group: "Guru", intervalMs: 7 * DAY },
    { name: "Guru 2", group: "Guru", intervalMs: 14 * DAY },
    { name: "Master", group: "Master", intervalMs: 30 * DAY },
    { name: "Enlightened", group: "Enlightened", intervalMs: 120 * DAY },
  ],
  // Guru 1 and above drop two stages on a fail; Apprentice drops one.
  heavyPenaltyFromStage: 5,
};

export const DEFAULT_CONFIG: AppConfig = {
  timeoutMs: 30_000,
  srs: WANIKANI_SRS,
  shortcuts: { reveal: "r", pass: "p", fail: "f", next: "n" },
};
