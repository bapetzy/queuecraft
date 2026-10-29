<script lang="ts">
  import { LIMITS, nominalCapacity } from '../engine/config';
  import type { BackoffKind, FaultKind, SimConfig } from '../engine/types';
  import { ms, num, pct } from '../lib/format';
  import Slider from './Slider.svelte';

  interface Props {
    config: SimConfig;
    activeFaults: FaultKind[];
    onchange: <K extends keyof SimConfig>(key: K, value: SimConfig[K]) => void;
    oninject: (kind: FaultKind, durationMs: number) => void;
  }

  let { config, activeFaults, onchange, oninject }: Props = $props();

  let faultSeconds = $state(10);

  const capacity = $derived(nominalCapacity(config));
  const load = $derived(capacity > 0 ? config.arrivalRate / capacity : 0);

  const FAULTS: { kind: FaultKind; name: string; detail: string }[] = [
    { kind: 'outage', name: 'Outage', detail: 'dependency down, calls fail in 60 ms' },
    { kind: 'slowdown', name: 'Slowdown', detail: 'dependency 6x slower' },
    { kind: 'spike', name: 'Spike', detail: 'traffic x4' },
    { kind: 'crash', name: 'Crash', detail: 'half the workers die' },
  ];

  const BACKOFFS: { kind: BackoffKind; name: string }[] = [
    { kind: 'none', name: 'None' },
    { kind: 'fixed', name: 'Fixed' },
    { kind: 'exponential', name: 'Exponential' },
  ];

  const r = (k: keyof typeof LIMITS) => ({ min: LIMITS[k][0], max: LIMITS[k][1], step: LIMITS[k][2] });
</script>

<div class="controls">
  <section aria-labelledby="sec-traffic">
    <h2 id="sec-traffic" class="label">Traffic</h2>
    <Slider
      id="arrivalRate"
      label="Arrivals"
      value={config.arrivalRate}
      {...r('arrivalRate')}
      display="{num(config.arrivalRate, 1)} /s"
      onchange={(v) => onchange('arrivalRate', v)}
    />
    <div class="seg" role="group" aria-label="Arrival pattern">
      <button class="key" aria-pressed={config.arrivalPattern === 'poisson'} onclick={() => onchange('arrivalPattern', 'poisson')}>Random</button>
      <button class="key" aria-pressed={config.arrivalPattern === 'steady'} onclick={() => onchange('arrivalPattern', 'steady')}>Evenly spaced</button>
    </div>
    <Slider
      id="poisonRate"
      label="Poison jobs"
      value={config.poisonRate}
      {...r('poisonRate')}
      display={pct(config.poisonRate)}
      hint="Share of jobs that fail on every attempt."
      onchange={(v) => onchange('poisonRate', v)}
    />
    <Slider
      id="queueCapacity"
      label="Queue limit"
      value={config.queueCapacity}
      {...r('queueCapacity')}
      display={config.queueCapacity === 0 ? 'unbounded' : String(config.queueCapacity)}
      hint="Jobs beyond the limit are dropped at the door."
      onchange={(v) => onchange('queueCapacity', v)}
    />
  </section>

  <section aria-labelledby="sec-workers">
    <h2 id="sec-workers" class="label">Workers</h2>
    <Slider
      id="workerCount"
      label="Workers"
      value={config.workerCount}
      {...r('workerCount')}
      display={String(config.workerCount)}
      onchange={(v) => onchange('workerCount', v)}
    />
    <Slider
      id="serviceTimeMs"
      label="Mean work per job"
      value={config.serviceTimeMs}
      {...r('serviceTimeMs')}
      display={ms(config.serviceTimeMs)}
      onchange={(v) => onchange('serviceTimeMs', v)}
    />
    <Slider
      id="serviceSpread"
      label="Size spread"
      value={config.serviceSpread}
      {...r('serviceSpread')}
      display={num(config.serviceSpread, 2)}
      hint="How uneven jobs are. Big jobs stay big when retried."
      onchange={(v) => onchange('serviceSpread', v)}
    />
    <Slider
      id="failureRate"
      label="Transient errors"
      value={config.failureRate}
      {...r('failureRate')}
      display={pct(config.failureRate)}
      onchange={(v) => onchange('failureRate', v)}
    />
    <p class="capacity" class:over={load >= 1}>
      <span class="label">Capacity</span>
      <span class="num">{num(capacity, 1)} /s</span>
      <span class="label">load</span>
      <span class="num">{pct(load)}</span>
    </p>
  </section>

  <section aria-labelledby="sec-policy">
    <h2 id="sec-policy" class="label">Retry policy</h2>
    <Slider
      id="maxAttempts"
      label="Max attempts"
      value={config.maxAttempts}
      {...r('maxAttempts')}
      display={config.maxAttempts === 1 ? '1 (no retry)' : String(config.maxAttempts)}
      onchange={(v) => onchange('maxAttempts', v)}
    />
    <Slider
      id="timeoutMs"
      label="Timeout"
      value={config.timeoutMs}
      {...r('timeoutMs')}
      display={config.timeoutMs === 0 ? 'none' : ms(config.timeoutMs)}
      onchange={(v) => onchange('timeoutMs', v)}
    />
    <div class="seg" role="group" aria-label="Backoff">
      {#each BACKOFFS as b (b.kind)}
        <button class="key" aria-pressed={config.backoff === b.kind} onclick={() => onchange('backoff', b.kind)}>{b.name}</button>
      {/each}
    </div>
    {#if config.backoff !== 'none'}
      <Slider
        id="backoffBaseMs"
        label={config.backoff === 'fixed' ? 'Delay' : 'First delay'}
        value={config.backoffBaseMs}
        {...r('backoffBaseMs')}
        display={ms(config.backoffBaseMs)}
        onchange={(v) => onchange('backoffBaseMs', v)}
      />
      {#if config.backoff === 'exponential'}
        <Slider
          id="backoffCapMs"
          label="Max delay"
          value={config.backoffCapMs}
          {...r('backoffCapMs')}
          display={ms(config.backoffCapMs)}
          onchange={(v) => onchange('backoffCapMs', v)}
        />
      {/if}
      <label class="check">
        <input type="checkbox" checked={config.jitter} onchange={(e) => onchange('jitter', e.currentTarget.checked)} />
        <span>Full jitter <span class="muted">(random wait up to the delay)</span></span>
      </label>
    {/if}
  </section>

  <section aria-labelledby="sec-faults">
    <h2 id="sec-faults" class="label">Inject a fault</h2>
    <div class="faults">
      {#each FAULTS as f (f.kind)}
        <button class="key fault" class:live={activeFaults.includes(f.kind)} onclick={() => oninject(f.kind, faultSeconds * 1000)} title={f.detail}>
          <i aria-hidden="true"></i>{f.name}
        </button>
      {/each}
    </div>
    <div class="seg" role="group" aria-label="Fault duration">
      {#each [5, 10, 20] as s (s)}
        <button class="key small" aria-pressed={faultSeconds === s} onclick={() => (faultSeconds = s)}>{s} s</button>
      {/each}
    </div>
  </section>
</div>

<style>
  .controls {
    display: grid;
    gap: 14px;
  }

  section {
    display: grid;
    gap: 10px;
    padding: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  h2 {
    margin: 0;
    color: var(--ink);
    font-size: 13px;
  }

  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .seg .key {
    flex: 1 1 auto;
    min-height: 30px;
    font-size: 12px;
    padding: 0 8px;
  }

  .capacity {
    margin: 2px 0 0;
    display: flex;
    gap: 6px;
    align-items: baseline;
    flex-wrap: wrap;
    font-size: 13px;
  }

  .capacity .num {
    color: var(--green);
    margin-right: 6px;
  }

  .capacity.over .num {
    color: var(--red);
  }

  .check {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
  }

  .check input {
    accent-color: var(--amber);
    width: 16px;
    height: 16px;
  }

  .muted {
    color: var(--muted);
  }

  .faults {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .fault {
    justify-content: flex-start;
  }

  .fault i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #121a17;
    border: 1px solid var(--line-strong);
  }

  .fault.live {
    border-color: var(--red);
    color: var(--red);
  }

  .fault.live i {
    background: var(--red);
    border-color: var(--red);
    box-shadow: 0 0 8px var(--red);
  }
</style>
