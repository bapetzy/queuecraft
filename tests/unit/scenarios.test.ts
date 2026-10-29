import { describe, expect, it } from 'vitest';
import { nominalCapacity } from '../../src/engine/config';
import { SCENARIOS, findScenario } from '../../src/engine/scenarios';
import { Simulation } from '../../src/engine/simulation';
import { decodeShare, encodeShare } from '../../src/lib/share';

/**
 * The scenario cards make claims ("the queue drains", "attempts jump far above
 * arrivals"). These tests run each problem and its fix and check the claims hold.
 */
function run(id: string, which: 'problem' | 'fix', until = 60_000) {
  const sc = findScenario(id)!;
  const config = which === 'fix' ? sc.fix!.config : sc.config;
  const sim = new Simulation(config, sc.seed, sc.faults);
  sim.advanceTo(until);
  return sim;
}

const attemptsPerJob = (sim: Simulation) => sim.totals.finishedAttempts / sim.totals.finishedJobs;

describe('scenario claims', () => {
  it('every scenario has a unique id and a valid config', () => {
    const ids = new Set(SCENARIOS.map((s) => s.id));
    expect(ids.size).toBe(SCENARIOS.length);
  });

  it('steady state: capacity exceeds arrivals and the queue stays short', () => {
    const sc = findScenario('steady')!;
    expect(nominalCapacity(sc.config)).toBeGreaterThan(sc.config.arrivalRate);
    const sim = run('steady', 'problem');
    const maxDepth = Math.max(...sim.samples.map((s) => s.queueDepth));
    expect(maxDepth).toBeLessThan(20);
    expect(sim.dlq.length).toBeLessThan(5);
  });

  it('retry storm: attempts ~8x arrivals during the outage; the fix cuts load and dead letters', () => {
    const problem = run('retry-storm', 'problem', 40_000);
    const fix = run('retry-storm', 'fix', 40_000);
    const during = (sim: Simulation) => sim.samples.filter((s) => s.t > 11_000 && s.t <= 25_000);
    const sum = (sim: Simulation, k: 'attempts' | 'arrivals') => during(sim).reduce((a, s) => a + s[k], 0);
    expect(sum(problem, 'attempts') / sum(problem, 'arrivals')).toBeGreaterThan(6);
    expect(sum(fix, 'attempts')).toBeLessThan(sum(problem, 'attempts') * 0.75);
    expect(fix.dlq.length).toBeLessThan(problem.dlq.length / 5);
    expect(problem.totals.arrived).toBe(fix.totals.arrived);
  });

  it('poison: backlog grows with ten tries, drains with three', () => {
    const problem = run('poison', 'problem', 90_000);
    const fix = run('poison', 'fix', 90_000);
    const lastDepth = (sim: Simulation) => sim.samples[sim.samples.length - 1].queueDepth;
    expect(lastDepth(problem)).toBeGreaterThan(30);
    expect(lastDepth(fix)).toBeLessThan(15);
    expect(fix.dlq.every((j) => j.poison)).toBe(true);
  });

  it('timeout: ~2 in 5 attempts time out, big jobs die, workers >90% busy; the fix drops to ~60%', () => {
    const problem = run('timeout', 'problem');
    const fix = run('timeout', 'fix');
    const share = problem.totals.byOutcome.timeout / problem.totals.attempts;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.5);
    const util = (sim: Simulation) => {
      const xs = sim.samples.slice(10).map((s) => s.running / s.activeWorkers);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(util(problem)).toBeGreaterThan(0.9);
    expect(util(fix)).toBeGreaterThan(0.5);
    expect(util(fix)).toBeLessThan(0.7);
    expect(problem.dlq.length).toBeGreaterThan(10);
    expect(problem.dlq.every((j) => j.attempts.every((a) => a.outcome === 'timeout' || a.outcome === 'error'))).toBe(true);
    expect(fix.dlq.length).toBe(0);
    expect(attemptsPerJob(fix)).toBeLessThan(attemptsPerJob(problem));
  });

  it('under-provisioned: backlog grows about four a second; the fix holds steady near 75%', () => {
    const problem = run('under-provisioned', 'problem');
    const growth = (problem.samples[59].queueDepth - problem.samples[19].queueDepth) / 40;
    expect(growth).toBeGreaterThan(3);
    expect(growth).toBeLessThan(5);
    const fix = run('under-provisioned', 'fix');
    expect(fix.samples.at(-1)!.queueDepth).toBeLessThan(15);
    const busy = fix.samples.slice(20).map((s) => s.running / s.activeWorkers);
    const avg = busy.reduce((a, b) => a + b, 0) / busy.length;
    expect(avg).toBeGreaterThan(0.6);
    expect(avg).toBeLessThan(0.9);
  });

  it('spike: the small queue drops jobs, the big one does not', () => {
    const problem = run('spike', 'problem', 40_000);
    const fix = run('spike', 'fix', 40_000);
    expect(problem.totals.dropped).toBeGreaterThan(20);
    expect(fix.totals.dropped).toBe(0);
  });
});

describe('share links', () => {
  it('round-trips scenario, seed and config', () => {
    const sc = SCENARIOS[1];
    const hash = encodeShare({ scenarioId: sc.id, seed: 123, config: sc.config });
    const out = decodeShare(hash);
    expect(out).toEqual({ ok: true, state: { scenarioId: sc.id, seed: 123, config: sc.config } });
  });

  it('rejects garbage without throwing', () => {
    expect(decodeShare('')).toEqual({ ok: false, reason: 'empty' });
    expect(decodeShare('#run=%%%not-base64')).toEqual({ ok: false, reason: 'unreadable' });
    expect(decodeShare('#run=' + btoa('{"v":2}'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('sanitizes values from a hand-edited link', () => {
    const hash = '#run=' + btoa(JSON.stringify({ v: 1, s: 'nope', seed: -5.5, c: { workerCount: 999 } }));
    const out = decodeShare(hash);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.state.scenarioId).toBe('sandbox');
      expect(out.state.seed).toBe(6);
      expect(out.state.config.workerCount).toBe(24);
    }
  });
});
