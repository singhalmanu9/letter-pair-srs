/** Fixed-stage scheduling rules (WaniKani-style). Pure functions. */

import type { SrsConfig } from "./config";

export const NEW_STAGE = 0;

export function burnedStage(config: SrsConfig): number {
  return config.stages.length + 1;
}

export function isBurned(stage: number, config: SrsConfig): boolean {
  return stage >= burnedStage(config);
}

/** A pass moves the pair up one stage. */
export function stageAfterPass(stage: number, config: SrsConfig): number {
  return Math.min(stage + 1, burnedStage(config));
}

/**
 * A fail drops the pair one stage, or two from `heavyPenaltyFromStage` up,
 * but never below the first learning stage. Matches WaniKani for a single
 * incorrect answer.
 */
export function stageAfterFail(stage: number, config: SrsConfig): number {
  const drop = stage >= config.heavyPenaltyFromStage ? 2 : 1;
  return Math.max(1, stage - drop);
}

/** When a pair that just reached `stage` is next due, or null once burned. */
export function nextDueAt(stage: number, now: number, config: SrsConfig): number | null {
  if (isBurned(stage, config)) return null;
  if (stage === NEW_STAGE) return now;
  const entry = config.stages[stage - 1];
  if (!entry) throw new Error(`Invalid stage: ${stage}`);
  return now + entry.intervalMs;
}

export function stageName(stage: number, config: SrsConfig): string {
  if (stage === NEW_STAGE) return "New";
  if (isBurned(stage, config)) return "Burned";
  return config.stages[stage - 1]?.name ?? `Stage ${stage}`;
}
