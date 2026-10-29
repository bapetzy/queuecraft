import { DEFAULT_CONFIG } from './config';
import type { FaultSpec, SimConfig } from './types';

export interface Scenario {
  id: string;
  title: string;
  /** One line under the title. */
  kicker: string;
  /** What is going on, in two or three sentences. */
  story: string;
  /** What to watch on the panel. */
  watch: string;
  seed: number;
  config: SimConfig;
  faults: FaultSpec[];
  fix?: {
    label: string;
    config: SimConfig;
    explanation: string;
  };
}

const base = (over: Partial<SimConfig>): SimConfig => ({ ...DEFAULT_CONFIG, ...over });

const retryStormProblem = base({
  arrivalRate: 10,
  workerCount: 8,
  serviceTimeMs: 400,
  serviceSpread: 0.3,
  failureRate: 0.02,
  maxAttempts: 8,
  backoff: 'none',
  jitter: false,
});

const poisonProblem = base({
  arrivalRate: 5,
  workerCount: 4,
  serviceTimeMs: 600,
  serviceSpread: 0.3,
  failureRate: 0.02,
  poisonRate: 0.04,
  maxAttempts: 10,
  backoff: 'fixed',
  backoffBaseMs: 1000,
  jitter: false,
});

const timeoutProblem = base({
  arrivalRate: 7,
  workerCount: 8,
  serviceTimeMs: 800,
  serviceSpread: 0.7,
  failureRate: 0.01,
  timeoutMs: 1000,
  maxAttempts: 5,
  backoff: 'none',
  jitter: false,
});

const underProblem = base({
  arrivalRate: 12,
  workerCount: 4,
  serviceTimeMs: 500,
  serviceSpread: 0.3,
  failureRate: 0.01,
  maxAttempts: 3,
});

const spikeProblem = base({
  arrivalRate: 6,
  workerCount: 6,
  serviceTimeMs: 600,
  serviceSpread: 0.3,
  failureRate: 0.01,
  queueCapacity: 40,
  maxAttempts: 3,
});

export const SCENARIOS: Scenario[] = [
  {
    id: 'steady',
    title: 'Steady state',
    kicker: 'A healthy queue, for reference',
    story:
      'Eight jobs a second arrive, six workers can finish twelve. One attempt in twenty fails and is retried with exponential backoff.',
    watch:
      'The queue stays short, workers idle now and then, and retried jobs drift round the backoff loop before rejoining. Inject a fault to see how it copes.',
    seed: 1207,
    config: base({}),
    faults: [],
  },
  {
    id: 'retry-storm',
    title: 'Retry storm',
    kicker: 'A dependency goes down and instant retries hammer it',
    story:
      'At 10 s the downstream service goes down for 15 s. Every attempt fails in 60 ms and goes straight back on the queue, up to eight times.',
    watch:
      'Attempts per second jumps to eight or more times the arrival rate: each job burns all eight tries in half a second, so nearly every job that arrives during the outage ends in the DLQ.',
    seed: 4242,
    config: retryStormProblem,
    faults: [{ kind: 'outage', at: 10_000, durationMs: 15_000 }],
    fix: {
      label: 'Exponential backoff + jitter',
      config: {
        ...retryStormProblem,
        backoff: 'exponential',
        backoffBaseMs: 500,
        backoffCapMs: 10_000,
        jitter: true,
      },
      explanation:
        'Waiting up to 0.5, 1, 2, 4, 8 s (randomised) between tries spreads the retries across the outage. Fewer calls hit the dead dependency, and almost every job is still alive when it comes back. Expect a backlog right after recovery while the waiting jobs catch up.',
    },
  },
  {
    id: 'poison',
    title: 'Poison messages',
    kicker: 'A few jobs can never succeed, and they are allowed ten tries',
    story:
      'Four percent of jobs are malformed and fail on every attempt. The policy retries each one ten times, one second apart.',
    watch:
      'Poison jobs (dark centre dot) keep coming back round the loop and occupy workers. The backlog creeps up and latency for healthy jobs climbs with it.',
    seed: 77,
    config: poisonProblem,
    faults: [],
    fix: {
      label: 'Cap attempts at 3',
      config: { ...poisonProblem, maxAttempts: 3 },
      explanation:
        'Poison jobs reach the DLQ after three tries, where they can be inspected and redriven once fixed. Workers go back to healthy work and the queue drains.',
    },
  },
  {
    id: 'timeout',
    title: 'Timeout shorter than the tail',
    kicker: 'Big jobs are killed at one second, every time they run',
    story:
      'Processing takes 800 ms on average, but about one job in five is big enough to need more than a second, and it stays big when retried. The worker gives up at one second.',
    watch:
      'Two attempts in five time out. Big jobs burn a full second five times and still land in the DLQ, so the workers are busy over 90% of the time doing work that is thrown away.',
    seed: 9001,
    config: timeoutProblem,
    faults: [],
    fix: {
      label: 'Timeout above the slowest job',
      config: { ...timeoutProblem, timeoutMs: 4000 },
      explanation:
        'At four seconds the timeout only catches real hangs. Big jobs finish on the first try, nothing reaches the DLQ, and the same eight workers drop to about 60% busy.',
    },
  },
  {
    id: 'under-provisioned',
    title: 'Under-provisioned',
    kicker: 'Arrivals outpace the workers, and the queue never stops growing',
    story:
      'Twelve jobs a second arrive. Four workers at 500 ms each can finish eight. Nothing fails; there is simply not enough capacity.',
    watch:
      'Utilization pins at 100%, the backlog grows by about four jobs a second, and latency rises without limit. More retries or longer timeouts will not help.',
    seed: 314,
    config: underProblem,
    faults: [],
    fix: {
      label: 'Eight workers',
      config: { ...underProblem, workerCount: 8 },
      explanation:
        'Capacity of sixteen jobs a second against twelve arriving. Utilization settles near 75%, which leaves headroom for bursts.',
    },
  },
  {
    id: 'spike',
    title: 'Traffic spike, small queue',
    kicker: 'A burst arrives and the bounded queue sheds load',
    story:
      'At 8 s traffic quadruples for 10 s. The queue holds at most 40 jobs; anything beyond that is rejected at the door.',
    watch:
      'The queue fills to its limit within seconds and the drop counter starts climbing. Dropping is a choice: it protects latency for the jobs that get in.',
    seed: 2718,
    config: spikeProblem,
    faults: [{ kind: 'spike', at: 8_000, durationMs: 10_000, magnitude: 4 }],
    fix: {
      label: 'Bigger queue',
      config: { ...spikeProblem, queueCapacity: 400 },
      explanation:
        'A 400-job buffer absorbs the burst with no drops, and the workers drain it afterwards. The cost is latency: jobs at the back wait tens of seconds.',
    },
  },
];

export const SANDBOX_ID = 'sandbox';

export function findScenario(id: string | null | undefined): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
