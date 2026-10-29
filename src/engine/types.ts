export type BackoffKind = 'none' | 'fixed' | 'exponential';
export type ArrivalPattern = 'steady' | 'poisson';

export interface SimConfig {
  /** New jobs per second. */
  arrivalRate: number;
  arrivalPattern: ArrivalPattern;
  /** Max jobs waiting in the queue. 0 means unbounded. */
  queueCapacity: number;
  workerCount: number;
  /** Mean processing time of one attempt, in ms. */
  serviceTimeMs: number;
  /**
   * Spread of the processing time (lognormal sigma). Mostly per job, so a slow
   * job stays slow when retried. 0 = every attempt takes the mean.
   */
  serviceSpread: number;
  /** Chance that a healthy attempt fails with a transient error. */
  failureRate: number;
  /** Share of jobs that fail on every attempt (poison messages). */
  poisonRate: number;
  /** Worker gives up on an attempt after this many ms. 0 = no timeout. */
  timeoutMs: number;
  /** Attempts per job before it is dead-lettered. 1 = no retries. */
  maxAttempts: number;
  backoff: BackoffKind;
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Full jitter: wait a random time between 0 and the computed delay. */
  jitter: boolean;
}

export type Outcome = 'ok' | 'error' | 'timeout' | 'crash' | 'poison' | 'outage';
export type FailureOutcome = Exclude<Outcome, 'ok'>;

export type JobState = 'queued' | 'running' | 'backoff' | 'done' | 'dead' | 'dropped';

export interface Attempt {
  n: number;
  workerId: number;
  startedAt: number;
  plannedEnd: number;
  plannedOutcome: Outcome;
  endedAt: number | null;
  outcome: Outcome | null;
}

export interface Job {
  id: number;
  createdAt: number;
  poison: boolean;
  /** Work in this job relative to the mean (1 = average). Sticky across retries. */
  size: number;
  state: JobState;
  stateSince: number;
  attempts: Attempt[];
  /** Index in `attempts` where the current attempt budget starts (moves on redrive). */
  attemptBase: number;
  workerId: number | null;
  readyAt: number;
  backoffMs: number;
  finishedAt: number | null;
  redriven: number;
}

export type WorkerState = 'idle' | 'busy' | 'down' | 'retired';

export interface Worker {
  id: number;
  state: WorkerState;
  jobId: number | null;
  /** Bumped on every attempt start/abort so stale end events are ignored. */
  token: number;
  /** Leaves the pool once its current attempt ends (worker count was lowered). */
  retiring: boolean;
  /** Fault id that took the worker down, or 0. */
  downBy: number;
}

export type FaultKind = 'outage' | 'slowdown' | 'spike' | 'crash';

export interface FaultSpec {
  kind: FaultKind;
  /** Absolute sim time in ms. */
  at: number;
  durationMs: number;
  /** slowdown: latency multiplier, spike: traffic multiplier, crash: share of workers. */
  magnitude?: number;
}

export interface Fault extends FaultSpec {
  id: number;
  magnitude: number;
  active: boolean;
  ended: boolean;
}

export type LogKind =
  | 'arrive'
  | 'drop'
  | 'start'
  | 'ok'
  | 'fail'
  | 'retry'
  | 'dead'
  | 'redrive'
  | 'fault'
  | 'recover';

export interface LogEntry {
  seq: number;
  t: number;
  kind: LogKind;
  jobId?: number;
  workerId?: number;
  outcome?: Outcome;
  text: string;
}

export interface Sample {
  t: number;
  arrivals: number;
  completions: number;
  attempts: number;
  failures: number;
  dead: number;
  dropped: number;
  queueDepth: number;
  backoff: number;
  running: number;
  activeWorkers: number;
  p50: number | null;
  p95: number | null;
}

export interface Totals {
  arrived: number;
  completed: number;
  deadLettered: number;
  dropped: number;
  attempts: number;
  failures: number;
  retries: number;
  redriven: number;
  /** Attempts spent by jobs that have finished (done or dead). */
  finishedAttempts: number;
  finishedJobs: number;
  byOutcome: Record<Outcome, number>;
}

export interface Stats {
  now: number;
  arrived: number;
  completed: number;
  inDlq: number;
  dropped: number;
  queued: number;
  running: number;
  backoff: number;
  activeWorkers: number;
  busyWorkers: number;
  attemptsPerJob: number | null;
  utilization: number;
  p50: number | null;
  p95: number | null;
  throughput: number;
  activeFaults: FaultKind[];
}
