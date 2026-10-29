import { describe, expect, it } from 'vitest';
import { baseDelay, backoffDelay } from '../../src/engine/backoff';
import { DEFAULT_CONFIG, LIMITS, sanitizeConfig } from '../../src/engine/config';
import { Lab } from '../../src/engine/lab';
import { mulberry32 } from '../../src/engine/rng';
import { OUTAGE_FAIL_MS, Simulation } from '../../src/engine/simulation';
import { EventHeap } from '../../src/engine/structures';
import type { SimConfig } from '../../src/engine/types';

const cfg = (over: Partial<SimConfig> = {}): SimConfig => ({ ...DEFAULT_CONFIG, ...over });

/** Every job that ever arrived is in exactly one place. */
function conserved(sim: Simulation): boolean {
  const s = sim.stats();
  return (
    s.arrived ===
    s.completed + s.dropped + s.inDlq + sim.dlqEvicted + s.queued + s.running + s.backoff
  );
}

describe('EventHeap', () => {
  it('pops by time, then by insertion order', () => {
    const h = new EventHeap<{ time: number; seq: number; tag: string }>();
    [
      [5, 0, 'c'],
      [1, 1, 'a'],
      [5, 2, 'd'],
      [3, 3, 'b'],
    ].forEach(([time, seq, tag]) => h.push({ time: time as number, seq: seq as number, tag: tag as string }));
    expect([h.pop(), h.pop(), h.pop(), h.pop()].map((x) => x!.tag)).toEqual(['a', 'b', 'c', 'd']);
    expect(h.pop()).toBeUndefined();
  });
});

describe('backoff', () => {
  it('grows exponentially and respects the cap', () => {
    const c = cfg({ backoff: 'exponential', backoffBaseMs: 100, backoffCapMs: 1000 });
    expect([1, 2, 3, 4, 5, 6].map((n) => baseDelay(n, c))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it('fixed and none', () => {
    expect(baseDelay(4, cfg({ backoff: 'fixed', backoffBaseMs: 250 }))).toBe(250);
    expect(baseDelay(4, cfg({ backoff: 'none' }))).toBe(0);
  });

  it('full jitter stays inside [0, delay]', () => {
    const c = cfg({ backoff: 'exponential', backoffBaseMs: 100, backoffCapMs: 10_000, jitter: true });
    const rng = mulberry32(9);
    for (let n = 1; n <= 8; n++) {
      for (let i = 0; i < 200; i++) {
        const d = backoffDelay(n, c, rng);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(baseDelay(n, c));
      }
    }
  });
});

describe('sanitizeConfig', () => {
  it('clamps, rounds and rejects junk', () => {
    const out = sanitizeConfig({
      arrivalRate: 9999,
      workerCount: 3.7,
      failureRate: -1,
      backoff: 'sometimes',
      arrivalPattern: 'steady',
      jitter: 'yes',
      serviceTimeMs: 'NaN',
      evil: '<script>',
    });
    expect(out.arrivalRate).toBe(LIMITS.arrivalRate[1]);
    expect(out.workerCount).toBe(4);
    expect(out.failureRate).toBe(0);
    expect(out.backoff).toBe(DEFAULT_CONFIG.backoff);
    expect(out.arrivalPattern).toBe('steady');
    expect(out.jitter).toBe(DEFAULT_CONFIG.jitter);
    expect(out.serviceTimeMs).toBe(DEFAULT_CONFIG.serviceTimeMs);
    expect(out).not.toHaveProperty('evil');
  });

  it('never lets the cap sit below the base delay', () => {
    const out = sanitizeConfig({ backoffBaseMs: 5000, backoffCapMs: 100 });
    expect(out.backoffCapMs).toBe(5000);
  });

  it('falls back to defaults for non-objects', () => {
    expect(sanitizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(sanitizeConfig('x')).toEqual(DEFAULT_CONFIG);
  });
});

describe('Simulation', () => {
  it('is deterministic for a seed, however time is chunked', () => {
    const a = new Simulation(cfg(), 42);
    const b = new Simulation(cfg(), 42);
    a.advanceTo(30_000);
    for (let t = 0; t < 30_000; t += 16.7) b.advanceTo(t);
    b.advanceTo(30_000);
    expect(b.totals).toEqual(a.totals);
    expect(b.samples).toEqual(a.samples);
  });

  it('different seeds give different runs', () => {
    const a = new Simulation(cfg(), 1);
    const b = new Simulation(cfg(), 2);
    a.advanceTo(20_000);
    b.advanceTo(20_000);
    expect(a.totals).not.toEqual(b.totals);
  });

  it('conserves jobs through every kind of trouble', () => {
    const sim = new Simulation(
      cfg({ queueCapacity: 30, failureRate: 0.3, poisonRate: 0.05, timeoutMs: 700, arrivalRate: 20 }),
      7,
      [
        { kind: 'outage', at: 3000, durationMs: 4000 },
        { kind: 'crash', at: 9000, durationMs: 3000 },
        { kind: 'spike', at: 12_000, durationMs: 4000 },
      ],
    );
    for (let t = 500; t <= 25_000; t += 500) {
      sim.advanceTo(t);
      expect(conserved(sim)).toBe(true);
    }
    expect(sim.totals.dropped).toBeGreaterThan(0);
    expect(sim.totals.byOutcome.crash).toBeGreaterThan(0);
    expect(sim.totals.byOutcome.timeout).toBeGreaterThan(0);
  });

  it('roughly matches the arrival rate', () => {
    const sim = new Simulation(cfg({ arrivalRate: 10, arrivalPattern: 'steady' }), 3);
    sim.advanceTo(60_000);
    expect(sim.totals.arrived).toBeGreaterThanOrEqual(599);
    expect(sim.totals.arrived).toBeLessThanOrEqual(600);
  });

  it('with one attempt, every failure goes straight to the DLQ', () => {
    const sim = new Simulation(cfg({ maxAttempts: 1, failureRate: 0.5 }), 11);
    sim.advanceTo(20_000);
    expect(sim.totals.retries).toBe(0);
    expect(sim.totals.deadLettered).toBe(sim.totals.failures);
    expect(sim.dlq.every((j) => j.attempts.length === 1)).toBe(true);
  });

  it('poison jobs always end in the DLQ after exactly maxAttempts', () => {
    const sim = new Simulation(
      cfg({ poisonRate: 0.2, failureRate: 0, maxAttempts: 4, backoff: 'fixed', backoffBaseMs: 100, jitter: false }),
      5,
    );
    sim.advanceTo(30_000);
    const poisonDone = sim.finished.filter((j) => j.poison && j.state === 'done');
    expect(poisonDone).toHaveLength(0);
    expect(sim.dlq.length).toBeGreaterThan(0);
    for (const j of sim.dlq) {
      expect(j.poison).toBe(true);
      expect(j.attempts).toHaveLength(4);
      expect(j.attempts.every((a) => a.outcome === 'poison')).toBe(true);
    }
  });

  it('timeouts cut attempts at exactly the timeout', () => {
    const sim = new Simulation(cfg({ serviceTimeMs: 900, serviceSpread: 0.6, timeoutMs: 800, failureRate: 0 }), 8);
    sim.advanceTo(15_000);
    const attempts = [...sim.finished, ...sim.dlq].flatMap((j) => j.attempts);
    const timedOut = attempts.filter((a) => a.outcome === 'timeout');
    expect(timedOut.length).toBeGreaterThan(0);
    for (const a of timedOut) expect(a.endedAt! - a.startedAt).toBeCloseTo(800, 6);
    for (const a of attempts) expect(a.endedAt! - a.startedAt).toBeLessThanOrEqual(800 + 1e-6);
  });

  it('respects the backoff delay before a job is requeued', () => {
    const sim = new Simulation(
      cfg({ failureRate: 0.5, backoff: 'fixed', backoffBaseMs: 1500, jitter: false, maxAttempts: 5 }),
      21,
    );
    sim.advanceTo(30_000);
    const jobs = [...sim.finished, ...sim.dlq].filter((j) => j.attempts.length > 1);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      for (let i = 1; i < j.attempts.length; i++) {
        expect(j.attempts[i].startedAt - j.attempts[i - 1].endedAt!).toBeGreaterThanOrEqual(1500 - 1e-6);
      }
    }
  });

  it('during an outage attempts fail fast with the outage outcome', () => {
    const sim = new Simulation(cfg({ arrivalRate: 10 }), 2, [{ kind: 'outage', at: 5000, durationMs: 5000 }]);
    sim.advanceTo(10_000);
    const outageAttempts = [...sim.jobs.values(), ...sim.finished, ...sim.dlq]
      .flatMap((j) => j.attempts)
      .filter((a) => a.outcome === 'outage');
    expect(outageAttempts.length).toBeGreaterThan(10);
    for (const a of outageAttempts) {
      expect(a.startedAt).toBeGreaterThanOrEqual(5000);
      expect(a.endedAt! - a.startedAt).toBeLessThanOrEqual(OUTAGE_FAIL_MS);
    }
    expect(sim.activeFaultKinds()).toEqual([]);
  });

  it('a crash fails in-flight attempts and brings workers back later', () => {
    const sim = new Simulation(cfg({ arrivalRate: 20, workerCount: 8, serviceTimeMs: 800 }), 4);
    sim.advanceTo(5000);
    sim.scheduleFault({ kind: 'crash', durationMs: 3000, magnitude: 0.5 });
    sim.advanceTo(5000);
    expect(sim.workers.filter((w) => w.state === 'down')).toHaveLength(4);
    expect(sim.totals.byOutcome.crash).toBeGreaterThan(0);
    expect(sim.stats().activeWorkers).toBe(4);
    sim.advanceTo(8001);
    expect(sim.workers.filter((w) => w.state === 'down')).toHaveLength(0);
    expect(sim.stats().activeWorkers).toBe(8);
  });

  it('a spike multiplies traffic only while it lasts', () => {
    const sim = new Simulation(cfg({ arrivalRate: 5, arrivalPattern: 'steady' }), 1, [
      { kind: 'spike', at: 10_000, durationMs: 10_000, magnitude: 4 },
    ]);
    sim.advanceTo(10_000);
    const before = sim.totals.arrived;
    sim.advanceTo(20_000);
    const during = sim.totals.arrived - before;
    sim.advanceTo(30_000);
    const after = sim.totals.arrived - before - during;
    expect(during).toBeGreaterThanOrEqual(195);
    expect(after).toBeLessThanOrEqual(52);
  });

  it('bounded queue drops jobs when full and never exceeds capacity', () => {
    const sim = new Simulation(cfg({ arrivalRate: 30, workerCount: 2, queueCapacity: 25 }), 6);
    for (let t = 200; t <= 15_000; t += 200) {
      sim.advanceTo(t);
      expect(sim.queue.length).toBeLessThanOrEqual(25);
    }
    expect(sim.totals.dropped).toBeGreaterThan(0);
  });

  it('lowering and raising worker count takes effect without losing jobs', () => {
    const sim = new Simulation(cfg({ arrivalRate: 15, workerCount: 10 }), 13);
    sim.advanceTo(5000);
    sim.updateConfig({ workerCount: 3 });
    sim.advanceTo(8000);
    expect(sim.stats().activeWorkers).toBe(3);
    expect(conserved(sim)).toBe(true);
    sim.updateConfig({ workerCount: 12 });
    sim.advanceTo(8001);
    expect(sim.stats().activeWorkers).toBe(12);
    expect(conserved(sim)).toBe(true);
  });

  it('arrival rate 0 stops traffic, raising it resumes', () => {
    const sim = new Simulation(cfg({ arrivalRate: 0 }), 1);
    sim.advanceTo(5000);
    expect(sim.totals.arrived).toBe(0);
    sim.updateConfig({ arrivalRate: 10, arrivalPattern: 'steady' });
    sim.advanceTo(10_000);
    expect(sim.totals.arrived).toBeGreaterThanOrEqual(49);
  });

  it('redrive moves DLQ jobs back with a fresh attempt budget', () => {
    const sim = new Simulation(cfg({ maxAttempts: 2, failureRate: 0.6, arrivalRate: 4 }), 10);
    sim.advanceTo(10_000);
    const dead = sim.dlq.length;
    expect(dead).toBeGreaterThan(0);
    sim.updateConfig({ failureRate: 0 });
    const ids = sim.dlq.map((j) => j.id);
    expect(sim.redriveDlq()).toBe(dead);
    expect(sim.dlq).toHaveLength(0);
    sim.advanceTo(30_000);
    for (const id of ids) {
      const job = sim.findJob(id)!;
      expect(job.redriven).toBe(1);
      expect(job.state).toBe('done');
    }
    expect(conserved(sim)).toBe(true);
  });

  it('samples once a second with latency percentiles in order', () => {
    const sim = new Simulation(cfg(), 99);
    sim.advanceTo(20_500);
    expect(sim.samples).toHaveLength(20);
    const last = sim.samples[19];
    expect(last.p50).not.toBeNull();
    expect(last.p95!).toBeGreaterThanOrEqual(last.p50!);
  });

  it('logSince returns only newer entries', () => {
    const sim = new Simulation(cfg(), 3);
    sim.advanceTo(2000);
    const mark = sim.lastLogSeq;
    expect(sim.logSince(mark)).toEqual([]);
    sim.advanceTo(4000);
    const fresh = sim.logSince(mark);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((e) => e.seq > mark)).toBe(true);
  });
});

describe('Lab', () => {
  it('ghost sees the same traffic and the same injected faults', () => {
    const lab = new Lab(cfg({ backoff: 'none' }), 5, [], cfg({ backoff: 'exponential' }));
    lab.advanceBy(3000);
    lab.inject('outage', 4000);
    lab.advanceBy(10_000);
    expect(lab.ghost!.totals.arrived).toBe(lab.main.totals.arrived);
    expect(lab.ghost!.faults).toHaveLength(1);
    expect(lab.ghost!.now).toBe(lab.main.now);
  });
});
