import type { Rng } from './rng';
import type { SimConfig } from './types';

/** Delay before the next try, before jitter. `failedAttempt` starts at 1. */
export function baseDelay(failedAttempt: number, cfg: SimConfig): number {
  switch (cfg.backoff) {
    case 'none':
      return 0;
    case 'fixed':
      return cfg.backoffBaseMs;
    case 'exponential':
      return Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (failedAttempt - 1));
  }
}

/** Delay with optional full jitter (a random wait in [0, delay]). */
export function backoffDelay(failedAttempt: number, cfg: SimConfig, rng: Rng): number {
  const d = baseDelay(failedAttempt, cfg);
  if (d <= 0) return 0;
  return Math.round(cfg.jitter ? rng() * d : d);
}
