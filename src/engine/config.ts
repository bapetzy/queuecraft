import type { ArrivalPattern, BackoffKind, SimConfig } from './types';

export const MAX_WORKERS = 24;

type NumericKey = {
  [K in keyof SimConfig]: SimConfig[K] extends number ? K : never;
}[keyof SimConfig];

/** min, max, step. Used for sanitizing input and for the slider ranges. */
export const LIMITS: Record<NumericKey, readonly [number, number, number]> = {
  arrivalRate: [0, 60, 0.5],
  queueCapacity: [0, 2000, 10],
  workerCount: [1, MAX_WORKERS, 1],
  serviceTimeMs: [20, 5000, 10],
  serviceSpread: [0, 1.2, 0.05],
  failureRate: [0, 1, 0.01],
  poisonRate: [0, 0.5, 0.005],
  timeoutMs: [0, 20000, 50],
  maxAttempts: [1, 12, 1],
  backoffBaseMs: [10, 10000, 10],
  backoffCapMs: [10, 60000, 100],
};

export const DEFAULT_CONFIG: SimConfig = {
  arrivalRate: 8,
  arrivalPattern: 'poisson',
  queueCapacity: 0,
  workerCount: 6,
  serviceTimeMs: 500,
  serviceSpread: 0.35,
  failureRate: 0.05,
  poisonRate: 0,
  timeoutMs: 0,
  maxAttempts: 3,
  backoff: 'exponential',
  backoffBaseMs: 400,
  backoffCapMs: 8000,
  jitter: true,
};

const PATTERNS: readonly ArrivalPattern[] = ['steady', 'poisson'];
const BACKOFFS: readonly BackoffKind[] = ['none', 'fixed', 'exponential'];
const INTEGER_KEYS: readonly NumericKey[] = ['queueCapacity', 'workerCount', 'maxAttempts'];

function clampNumber(key: NumericKey, value: unknown, fallback: number): number {
  const [min, max] = LIMITS[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return INTEGER_KEYS.includes(key) ? Math.round(clamped) : clamped;
}

/**
 * Turn anything (a share link, a stale preset, a slider event) into a valid
 * config. Unknown keys are dropped, bad values fall back to `base`.
 */
export function sanitizeConfig(input: unknown, base: SimConfig = DEFAULT_CONFIG): SimConfig {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const key of Object.keys(LIMITS) as NumericKey[]) {
    if (key in src) out[key] = clampNumber(key, src[key], base[key]);
  }
  if (PATTERNS.includes(src.arrivalPattern as ArrivalPattern)) {
    out.arrivalPattern = src.arrivalPattern as ArrivalPattern;
  }
  if (BACKOFFS.includes(src.backoff as BackoffKind)) out.backoff = src.backoff as BackoffKind;
  if (typeof src.jitter === 'boolean') out.jitter = src.jitter;
  if (out.backoffCapMs < out.backoffBaseMs) out.backoffCapMs = out.backoffBaseMs;
  return out;
}

/** Jobs per second the pool can finish when nothing fails. */
export function nominalCapacity(cfg: SimConfig): number {
  return (cfg.workerCount * 1000) / cfg.serviceTimeMs;
}
