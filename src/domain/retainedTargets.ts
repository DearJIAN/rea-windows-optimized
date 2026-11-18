/** Maximum resident targets, or an adaptive host-memory policy. */
export type RetainedTargetLimit = 2 | 3 | 4 | 5 | "auto";

/** A malformed or unavailable host observation is unknown, never low pressure. */
export const physicalMemoryPressure = (
  total: number,
  available: number,
): "high" | "normal" | "unknown" =>
  Number.isSafeInteger(total) &&
  Number.isSafeInteger(available) &&
  total > 0 &&
  available >= 0 &&
  available <= total
    ? available / total <= 0.1
      ? "high"
      : "normal"
    : "unknown";
