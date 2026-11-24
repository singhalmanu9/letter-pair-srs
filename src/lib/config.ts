/** Configurable SRS parameters. All durations are in seconds. */
export interface SRSConfig {
  timeoutSeconds: number;
  initialInterval: number;
  passIntervalMultiplier: number;
  failIntervalReset: number;
  shortcuts: {
    reveal: string;
    pass: string;
    fail: string;
    next: string;
  };
}

export const DEFAULT_CONFIG: SRSConfig = {
  timeoutSeconds: 30,
  initialInterval: 60,
  passIntervalMultiplier: 1.5,
  failIntervalReset: 60,
  shortcuts: { reveal: "r", pass: "p", fail: "f", next: "n" },
};

/** Current wall-clock time as Unix seconds (the unit used throughout state). */
export function nowSeconds(): number {
  return Date.now() / 1000;
}
