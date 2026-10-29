import { backoffDelay } from './backoff';
import { MAX_WORKERS, sanitizeConfig } from './config';
import { exponential, mulberry32, normal, streamSeed, type Rng } from './rng';
import { Deque, EventHeap } from './structures';
import type {
  Attempt,
  FailureOutcome,
  Fault,
  FaultKind,
  FaultSpec,
  Job,
  LogEntry,
  LogKind,
  Outcome,
  Sample,
  SimConfig,
  Stats,
  Totals,
  Worker,
} from './types';

/** Attempts against a dependency that is down fail after this long. */
export const OUTAGE_FAIL_MS = 60;
export const MIN_SERVICE_MS = 5;
export const SAMPLE_EVERY_MS = 1000;
/** Rolling window for latency percentiles. */
export const LATENCY_WINDOW_MS = 10_000;
/** Even an "unbounded" queue stops somewhere, so memory stays sane. */
export const HARD_QUEUE_LIMIT = 50_000;
const DLQ_LIMIT = 2000;
const FINISHED_LIMIT = 300;
const LOG_LIMIT = 4000;
const SAMPLE_LIMIT = 1200;
const RATE_RECHECK_MS = 250;
/** Split of the service-time spread between the job (sticky) and each attempt (fresh). */
const JOB_SPREAD_SHARE = 0.85;
const ATTEMPT_SPREAD_SHARE = 0.5;

const DEFAULT_MAGNITUDE: Record<FaultKind, number> = {
  outage: 1,
  slowdown: 6,
  spike: 4,
  crash: 0.5,
};

type SimEvent =
  | { time: number; seq: number; type: 'arrival'; token: number; create: boolean }
  | { time: number; seq: number; type: 'attemptEnd'; workerId: number; token: number }
  | { time: number; seq: number; type: 'backoffEnd'; jobId: number }
  | { time: number; seq: number; type: 'faultStart'; faultId: number }
  | { time: number; seq: number; type: 'faultEnd'; faultId: number }
  | { time: number; seq: number; type: 'sample' };

type NewEvent = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 'seq'> : never) : never;

const OUTCOME_LABEL: Record<Outcome, string> = {
  ok: 'done',
  error: 'transient error',
  timeout: 'timed out',
  crash: 'worker crashed',
  poison: 'poison message',
  outage: 'dependency down',
};

function emptyTotals(): Totals {
  return {
    arrived: 0,
    completed: 0,
    deadLettered: 0,
    dropped: 0,
    attempts: 0,
    failures: 0,
    retries: 0,
    redriven: 0,
    finishedAttempts: 0,
    finishedJobs: 0,
    byOutcome: { ok: 0, error: 0, timeout: 0, crash: 0, poison: 0, outage: 0 },
  };
}

/**
 * Discrete-event simulation of one job queue: a producer, a FIFO queue, a pool
 * of workers, a retry policy with backoff, timeouts and a dead-letter queue.
 *
 * Time only moves through `advanceTo`. Every random draw comes from seeded
 * streams, so the same seed, config and actions always give the same run,
 * however the calls are chunked into frames.
 */
export class Simulation {
  readonly seed: number;
  config: SimConfig;
  now = 0;

  readonly jobs = new Map<number, Job>();
  readonly queue = new Deque<number>();
  readonly backoffJobs = new Set<number>();
  readonly workers: Worker[] = [];
  dlq: Job[] = [];
  dlqEvicted = 0;
  readonly finished: Job[] = [];
  readonly log: LogEntry[] = [];
  readonly samples: Sample[] = [];
  readonly faults: Fault[] = [];
  readonly totals: Totals = emptyTotals();

  private heap = new EventHeap<SimEvent>();
  private seq = 0;
  private logSeq = 0;
  private nextJobId = 1;
  private nextFaultId = 1;
  private arrivalToken = 0;
  private latencies: { t: number; ms: number }[] = [];
  private bucket = { arrivals: 0, completions: 0, attempts: 0, failures: 0, dead: 0, dropped: 0 };

  private rngArrival: Rng;
  private rngService: Rng;
  private rngBackoff: Rng;
  private rngPoison: Rng;
  private rngSize: Rng;

  constructor(config: Partial<SimConfig>, seed: number, faults: FaultSpec[] = []) {
    this.seed = seed >>> 0;
    this.config = sanitizeConfig(config);
    this.rngArrival = mulberry32(streamSeed(this.seed, 1));
    this.rngService = mulberry32(streamSeed(this.seed, 2));
    this.rngBackoff = mulberry32(streamSeed(this.seed, 3));
    this.rngPoison = mulberry32(streamSeed(this.seed, 4));
    this.rngSize = mulberry32(streamSeed(this.seed, 5));
    this.setWorkerCount(this.config.workerCount);
    for (const f of faults) this.scheduleFault(f);
    this.scheduleArrival();
    this.push({ time: SAMPLE_EVERY_MS, type: 'sample' });
  }

  // ---------------------------------------------------------------- public API

  /** Process every event up to and including `target`, then move the clock there. */
  advanceTo(target: number): void {
    if (target < this.now) return;
    for (let ev = this.heap.peek(); ev && ev.time <= target; ev = this.heap.peek()) {
      this.heap.pop();
      this.now = ev.time;
      this.handle(ev);
      this.dispatch();
    }
    this.now = target;
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.now + Math.max(0, ms));
  }

  /** Apply a config change at the current time. Returns the sanitized config. */
  updateConfig(partial: Partial<SimConfig>): SimConfig {
    const prev = this.config;
    this.config = sanitizeConfig({ ...prev, ...partial }, prev);
    if (this.config.workerCount !== prev.workerCount) this.setWorkerCount(this.config.workerCount);
    if (
      this.config.arrivalRate !== prev.arrivalRate ||
      this.config.arrivalPattern !== prev.arrivalPattern
    ) {
      this.scheduleArrival();
    }
    this.dispatch();
    return this.config;
  }

  /** Schedule a fault. `at` defaults to now. Returns the fault id. */
  scheduleFault(spec: Omit<FaultSpec, 'at'> & { at?: number }): number {
    const fault: Fault = {
      kind: spec.kind,
      at: Math.max(this.now, spec.at ?? this.now),
      durationMs: Math.max(100, spec.durationMs),
      magnitude: spec.magnitude ?? DEFAULT_MAGNITUDE[spec.kind],
      id: this.nextFaultId++,
      active: false,
      ended: false,
    };
    this.faults.push(fault);
    this.push({ time: fault.at, type: 'faultStart', faultId: fault.id });
    this.push({ time: fault.at + fault.durationMs, type: 'faultEnd', faultId: fault.id });
    return fault.id;
  }

  /** Move every dead-lettered job back to the queue with a fresh attempt budget. */
  redriveDlq(): number {
    const jobs = this.dlq;
    this.dlq = [];
    for (const job of jobs) {
      job.attemptBase = job.attempts.length;
      job.redriven++;
      job.finishedAt = null;
      this.totals.redriven++;
      this.jobs.set(job.id, job);
      this.enqueue(job);
    }
    if (jobs.length > 0) {
      this.addLog('redrive', `${jobs.length} job${jobs.length === 1 ? '' : 's'} redriven from the DLQ`);
    }
    this.dispatch();
    return jobs.length;
  }

  /** Look up a job that is active, recently finished, dropped or in the DLQ. */
  findJob(id: number): Job | undefined {
    return (
      this.jobs.get(id) ??
      this.dlq.find((j) => j.id === id) ??
      this.finished.find((j) => j.id === id)
    );
  }

  activeFaultKinds(): FaultKind[] {
    return this.faults.filter((f) => f.active).map((f) => f.kind);
  }

  /** Workers that can take work right now (idle or busy). */
  activeWorkers(): number {
    return this.workers.filter((w) => w.state === 'idle' || w.state === 'busy').length;
  }

  stats(): Stats {
    let busy = 0;
    for (const w of this.workers) if (w.state === 'busy') busy++;
    const active = this.activeWorkers();
    const last = this.samples[this.samples.length - 1];
    const t = this.totals;
    const recent = this.samples.slice(-5);
    const throughput = recent.length
      ? recent.reduce((s, x) => s + x.completions, 0) / recent.length
      : 0;
    return {
      now: this.now,
      arrived: t.arrived,
      completed: t.completed,
      inDlq: this.dlq.length,
      dropped: t.dropped,
      queued: this.queue.length,
      running: busy,
      backoff: this.backoffJobs.size,
      activeWorkers: active,
      busyWorkers: busy,
      attemptsPerJob: t.finishedJobs > 0 ? t.finishedAttempts / t.finishedJobs : null,
      utilization: active > 0 ? Math.min(1, busy / active) : busy > 0 ? 1 : 0,
      p50: last?.p50 ?? null,
      p95: last?.p95 ?? null,
      throughput,
      activeFaults: this.activeFaultKinds(),
    };
  }

  /** Log entries newer than `seq` (the renderer uses this as an event stream). */
  logSince(seq: number): LogEntry[] {
    const log = this.log;
    if (log.length === 0 || log[log.length - 1].seq <= seq) return [];
    let i = log.length - 1;
    while (i > 0 && log[i - 1].seq > seq) i--;
    return log.slice(i);
  }

  get lastLogSeq(): number {
    return this.logSeq;
  }

  // ------------------------------------------------------------- event engine

  private push(ev: NewEvent): void {
    this.heap.push({ ...ev, seq: this.seq++ } as SimEvent);
  }

  private handle(ev: SimEvent): void {
    switch (ev.type) {
      case 'arrival':
        if (ev.token !== this.arrivalToken) return;
        if (ev.create) this.arrive();
        this.scheduleArrival(false);
        return;
      case 'attemptEnd': {
        const w = this.workers[ev.workerId];
        if (!w || w.token !== ev.token || w.state !== 'busy') return;
        const job = w.jobId === null ? undefined : this.jobs.get(w.jobId);
        const attempt = job?.attempts[job.attempts.length - 1];
        if (!job || !attempt) return;
        this.endAttempt(w, job, attempt.plannedOutcome);
        return;
      }
      case 'backoffEnd': {
        const job = this.jobs.get(ev.jobId);
        if (!job || job.state !== 'backoff' || job.readyAt !== ev.time) return;
        this.backoffJobs.delete(job.id);
        this.enqueue(job);
        return;
      }
      case 'faultStart':
        this.startFault(ev.faultId);
        return;
      case 'faultEnd':
        this.endFault(ev.faultId);
        return;
      case 'sample':
        this.takeSample();
        this.push({ time: this.now + SAMPLE_EVERY_MS, type: 'sample' });
        return;
    }
  }

  private effectiveRate(): number {
    let rate = this.config.arrivalRate;
    for (const f of this.faults) if (f.active && f.kind === 'spike') rate *= f.magnitude;
    return rate;
  }

  /**
   * Schedule the next arrival. With `restart`, any pending arrival is
   * cancelled first (rate or pattern changed).
   */
  private scheduleArrival(restart = true): void {
    if (restart) this.arrivalToken++;
    const rate = this.effectiveRate();
    if (rate <= 0) {
      this.push({
        time: this.now + RATE_RECHECK_MS,
        type: 'arrival',
        token: this.arrivalToken,
        create: false,
      });
      return;
    }
    const mean = 1000 / rate;
    const gap =
      this.config.arrivalPattern === 'steady' ? mean : exponential(this.rngArrival, mean);
    this.push({
      time: this.now + Math.max(0.5, gap),
      type: 'arrival',
      token: this.arrivalToken,
      create: true,
    });
  }

  private arrive(): void {
    const job: Job = {
      id: this.nextJobId++,
      createdAt: this.now,
      poison: this.rngPoison() < this.config.poisonRate,
      size: this.drawSize(),
      state: 'queued',
      stateSince: this.now,
      attempts: [],
      attemptBase: 0,
      workerId: null,
      readyAt: 0,
      backoffMs: 0,
      finishedAt: null,
      redriven: 0,
    };
    this.totals.arrived++;
    this.bucket.arrivals++;
    this.jobs.set(job.id, job);
    this.addLog('arrive', `job #${job.id} arrived`, job.id);
    this.enqueue(job);
  }

  /**
   * How much work a job is, relative to the mean. Most of the spread lives in
   * the job itself (a big payload is big on every try); the rest is per-attempt noise.
   */
  private drawSize(): number {
    const s = this.config.serviceSpread * JOB_SPREAD_SHARE;
    return Math.exp(-(s * s) / 2 + s * normal(this.rngSize));
  }

  private enqueue(job: Job): void {
    const cap = this.config.queueCapacity;
    const full = (cap > 0 && this.queue.length >= cap) || this.queue.length >= HARD_QUEUE_LIMIT;
    if (full) {
      job.state = 'dropped';
      job.stateSince = this.now;
      job.finishedAt = this.now;
      this.jobs.delete(job.id);
      this.totals.dropped++;
      this.bucket.dropped++;
      this.remember(job);
      this.addLog('drop', `job #${job.id} dropped: queue full`, job.id);
      return;
    }
    job.state = 'queued';
    job.stateSince = this.now;
    this.queue.push(job.id);
  }

  /** Hand queued jobs to idle workers, lowest worker id first. */
  private dispatch(): void {
    if (this.queue.length === 0) return;
    for (const w of this.workers) {
      if (this.queue.length === 0) return;
      if (w.state !== 'idle' || w.retiring) continue;
      let job: Job | undefined;
      while (!job && this.queue.length > 0) job = this.jobs.get(this.queue.shift()!);
      if (job) this.startAttempt(w, job);
    }
  }

  private startAttempt(w: Worker, job: Job): void {
    const cfg = this.config;
    let slow = 1;
    let outage = false;
    for (const f of this.faults) {
      if (!f.active) continue;
      if (f.kind === 'slowdown') slow *= f.magnitude;
      if (f.kind === 'outage') outage = true;
    }
    // Always draw the same numbers so one attempt's luck does not shift the next.
    const z = normal(this.rngService);
    const u = this.rngService();

    let duration: number;
    let outcome: Outcome;
    if (outage) {
      duration = Math.min(OUTAGE_FAIL_MS, cfg.serviceTimeMs);
      outcome = 'outage';
    } else {
      const mean = cfg.serviceTimeMs * slow * job.size;
      const s = cfg.serviceSpread * ATTEMPT_SPREAD_SHARE;
      duration = Math.max(MIN_SERVICE_MS, Math.exp(Math.log(mean) - (s * s) / 2 + s * z));
      outcome = job.poison ? 'poison' : u < cfg.failureRate ? 'error' : 'ok';
    }
    if (cfg.timeoutMs > 0 && duration > cfg.timeoutMs) {
      duration = cfg.timeoutMs;
      outcome = 'timeout';
    }

    const attempt: Attempt = {
      n: job.attempts.length + 1,
      workerId: w.id,
      startedAt: this.now,
      plannedEnd: this.now + duration,
      plannedOutcome: outcome,
      endedAt: null,
      outcome: null,
    };
    job.attempts.push(attempt);
    job.state = 'running';
    job.stateSince = this.now;
    job.workerId = w.id;
    w.state = 'busy';
    w.jobId = job.id;
    w.token++;
    this.totals.attempts++;
    this.bucket.attempts++;
    this.addLog(
      'start',
      `job #${job.id} attempt ${attempt.n - job.attemptBase} on worker ${w.id + 1}`,
      job.id,
      w.id,
    );
    this.push({ time: attempt.plannedEnd, type: 'attemptEnd', workerId: w.id, token: w.token });
  }

  private endAttempt(w: Worker, job: Job, outcome: Outcome): void {
    const attempt = job.attempts[job.attempts.length - 1];
    attempt.endedAt = this.now;
    attempt.outcome = outcome;
    this.totals.byOutcome[outcome]++;
    job.workerId = null;
    w.jobId = null;
    if (w.state === 'busy') {
      w.state = w.retiring ? 'retired' : 'idle';
      if (w.state === 'retired') w.retiring = false;
    }

    if (outcome === 'ok') {
      job.state = 'done';
      job.stateSince = this.now;
      job.finishedAt = this.now;
      this.jobs.delete(job.id);
      this.totals.completed++;
      this.totals.finishedJobs++;
      this.totals.finishedAttempts += job.attempts.length;
      this.bucket.completions++;
      this.latencies.push({ t: this.now, ms: this.now - job.createdAt });
      this.remember(job);
      this.addLog('ok', `job #${job.id} done`, job.id, w.id, 'ok');
      return;
    }
    this.fail(job, outcome, w.id);
  }

  private fail(job: Job, outcome: FailureOutcome, workerId: number): void {
    this.totals.failures++;
    this.bucket.failures++;
    const used = job.attempts.length - job.attemptBase;
    this.addLog('fail', `job #${job.id} failed: ${OUTCOME_LABEL[outcome]}`, job.id, workerId, outcome);

    if (used >= this.config.maxAttempts) {
      job.state = 'dead';
      job.stateSince = this.now;
      job.finishedAt = this.now;
      this.jobs.delete(job.id);
      this.totals.deadLettered++;
      this.totals.finishedJobs++;
      this.totals.finishedAttempts += job.attempts.length;
      this.bucket.dead++;
      this.dlq.push(job);
      if (this.dlq.length > DLQ_LIMIT) {
        this.dlq.shift();
        this.dlqEvicted++;
      }
      this.addLog('dead', `job #${job.id} dead-lettered after ${used} attempt${used === 1 ? '' : 's'}`, job.id);
      return;
    }

    this.totals.retries++;
    const delay = backoffDelay(used, this.config, this.rngBackoff);
    if (delay <= 0) {
      this.addLog('retry', `job #${job.id} retried immediately`, job.id);
      this.enqueue(job);
      return;
    }
    job.state = 'backoff';
    job.stateSince = this.now;
    job.backoffMs = delay;
    job.readyAt = this.now + delay;
    this.backoffJobs.add(job.id);
    this.addLog('retry', `job #${job.id} retries in ${delay} ms`, job.id);
    this.push({ time: job.readyAt, type: 'backoffEnd', jobId: job.id });
  }

  // ------------------------------------------------------------------ workers

  private setWorkerCount(n: number): void {
    const count = Math.max(1, Math.min(MAX_WORKERS, Math.round(n)));
    while (this.workers.length < count) {
      this.workers.push({
        id: this.workers.length,
        state: 'idle',
        jobId: null,
        token: 0,
        retiring: false,
        downBy: 0,
      });
    }
    this.workers.forEach((w, i) => {
      if (i < count) {
        w.retiring = false;
        if (w.state === 'retired') w.state = 'idle';
      } else if (w.state === 'idle') {
        w.state = 'retired';
      } else if (w.state === 'busy' || w.state === 'down') {
        w.retiring = true;
      }
    });
  }

  // ------------------------------------------------------------------- faults

  private startFault(id: number): void {
    const f = this.faults.find((x) => x.id === id);
    if (!f || f.active || f.ended) return;
    f.active = true;
    const secs = (f.durationMs / 1000).toFixed(f.durationMs % 1000 ? 1 : 0);
    switch (f.kind) {
      case 'outage':
        this.addLog('fault', `dependency down for ${secs} s`);
        break;
      case 'slowdown':
        this.addLog('fault', `dependency ${f.magnitude}x slower for ${secs} s`);
        break;
      case 'spike':
        this.addLog('fault', `traffic spike x${f.magnitude} for ${secs} s`);
        this.scheduleArrival();
        break;
      case 'crash':
        this.crashWorkers(f);
        break;
    }
  }

  private endFault(id: number): void {
    const f = this.faults.find((x) => x.id === id);
    if (!f || !f.active) return;
    f.active = false;
    f.ended = true;
    switch (f.kind) {
      case 'outage':
        this.addLog('recover', 'dependency back up');
        break;
      case 'slowdown':
        this.addLog('recover', 'dependency latency back to normal');
        break;
      case 'spike':
        this.addLog('recover', 'traffic back to normal');
        this.scheduleArrival();
        break;
      case 'crash': {
        let n = 0;
        for (const w of this.workers) {
          if (w.state !== 'down' || w.downBy !== f.id) continue;
          w.downBy = 0;
          w.state = w.retiring ? 'retired' : 'idle';
          w.retiring = false;
          n++;
        }
        this.addLog('recover', `${n} worker${n === 1 ? '' : 's'} restarted`);
        break;
      }
    }
  }

  private crashWorkers(f: Fault): void {
    const alive = this.workers.filter((w) => w.state === 'idle' || w.state === 'busy');
    const k = Math.min(alive.length, Math.max(1, Math.round(alive.length * f.magnitude)));
    const victims = alive.slice(alive.length - k);
    for (const w of victims) {
      w.token++; // invalidate the pending attemptEnd
      const job = w.jobId === null ? undefined : this.jobs.get(w.jobId);
      w.state = 'down';
      w.downBy = f.id;
      w.jobId = null;
      if (job) {
        const attempt = job.attempts[job.attempts.length - 1];
        attempt.endedAt = this.now;
        attempt.outcome = 'crash';
        this.totals.byOutcome.crash++;
        job.workerId = null;
        this.fail(job, 'crash', w.id);
      }
    }
    const secs = (f.durationMs / 1000).toFixed(0);
    this.addLog('fault', `${k} worker${k === 1 ? '' : 's'} crashed, back in ${secs} s`);
  }

  // ------------------------------------------------------------------ metrics

  private takeSample(): void {
    const cutoff = this.now - LATENCY_WINDOW_MS;
    let i = 0;
    while (i < this.latencies.length && this.latencies[i].t < cutoff) i++;
    if (i > 0) this.latencies.splice(0, i);
    const sorted = this.latencies.map((l) => l.ms).sort((a, b) => a - b);
    const pick = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;

    let running = 0;
    for (const w of this.workers) if (w.state === 'busy') running++;
    this.samples.push({
      t: this.now,
      ...this.bucket,
      queueDepth: this.queue.length,
      backoff: this.backoffJobs.size,
      running,
      activeWorkers: this.activeWorkers(),
      p50: pick(0.5),
      p95: pick(0.95),
    });
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
    this.bucket = { arrivals: 0, completions: 0, attempts: 0, failures: 0, dead: 0, dropped: 0 };
  }

  private remember(job: Job): void {
    this.finished.push(job);
    if (this.finished.length > FINISHED_LIMIT) this.finished.shift();
  }

  private addLog(
    kind: LogKind,
    text: string,
    jobId?: number,
    workerId?: number,
    outcome?: Outcome,
  ): void {
    this.log.push({ seq: ++this.logSeq, t: this.now, kind, text, jobId, workerId, outcome });
    if (this.log.length > LOG_LIMIT * 1.5) this.log.splice(0, this.log.length - LOG_LIMIT);
  }
}

export { OUTCOME_LABEL };
