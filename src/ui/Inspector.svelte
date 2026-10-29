<script lang="ts">
  import { OUTCOME_LABEL } from '../engine/simulation';
  import type { Job, LogEntry, Outcome } from '../engine/types';
  import { clock, ms } from '../lib/format';

  interface Props {
    job: Job | null;
    now: number;
    dlq: Job[];
    log: LogEntry[];
    serviceTimeMs: number;
    onselect: (id: number | null) => void;
    onredrive: () => void;
  }

  let { job, now, dlq, log, serviceTimeMs, onselect, onredrive }: Props = $props();

  const STATE_TEXT: Record<Job['state'], string> = {
    queued: 'waiting in the queue',
    running: 'running on a worker',
    backoff: 'waiting to retry',
    done: 'done',
    dead: 'in the dead-letter queue',
    dropped: 'dropped, queue was full',
  };

  const COLOUR: Record<Outcome, string> = {
    ok: 'var(--green)',
    error: 'var(--amber)',
    timeout: 'var(--amber)',
    crash: 'var(--red)',
    poison: 'var(--red)',
    outage: 'var(--red)',
  };

  const timeline = $derived.by(() => {
    if (!job) return null;
    const end = job.finishedAt ?? now;
    const span = Math.max(1, end - job.createdAt);
    return {
      span,
      bars: job.attempts.map((a) => ({
        n: a.n,
        left: ((a.startedAt - job.createdAt) / span) * 100,
        width: Math.max(0.8, (((a.endedAt ?? now) - a.startedAt) / span) * 100),
        outcome: a.outcome,
        took: (a.endedAt ?? now) - a.startedAt,
        workerId: a.workerId,
      })),
    };
  });

  const recentDlq = $derived(dlq.slice(-24).reverse());
</script>

<div class="inspector">
  <section aria-labelledby="ins-job">
    <div class="head">
      <h2 id="ins-job" class="label">Job trace</h2>
      {#if job}<button class="close" onclick={() => onselect(null)} aria-label="Close job trace">×</button>{/if}
    </div>
    {#if job && timeline}
      <p class="title">
        <span class="num">#{job.id}</span>
        <span class="state" data-state={job.state}>{STATE_TEXT[job.state]}</span>
      </p>
      <dl>
        <div><dt class="label">Arrived</dt><dd class="num">{clock(job.createdAt)}</dd></div>
        <div><dt class="label">Size</dt><dd class="num">{job.size.toFixed(2)}x ≈ {ms(job.size * serviceTimeMs)}</dd></div>
        <div><dt class="label">Attempts</dt><dd class="num">{job.attempts.length}{job.redriven ? ` (redriven ${job.redriven}x)` : ''}</dd></div>
        <div><dt class="label">{job.finishedAt === null ? 'Age' : 'Total'}</dt><dd class="num">{ms((job.finishedAt ?? now) - job.createdAt)}</dd></div>
      </dl>
      {#if job.poison}<p class="poison">Poison message: this job fails on every attempt.</p>{/if}
      <div class="track" aria-hidden="true">
        {#each timeline.bars as b (b.n)}
          <span class="bar" style:left="{b.left}%" style:width="{b.width}%" style:--c={b.outcome ? COLOUR[b.outcome] : 'var(--white)'}></span>
        {/each}
      </div>
      <ol class="attempts">
        {#each timeline.bars as b (b.n)}
          <li>
            <span class="num">{b.n}</span>
            <span class="dot" style:--c={b.outcome ? COLOUR[b.outcome] : 'var(--white)'}></span>
            <span>{b.outcome ? OUTCOME_LABEL[b.outcome] : 'running…'}</span>
            <span class="num muted">W{b.workerId + 1} · {ms(b.took)}</span>
          </li>
        {:else}
          <li class="muted">No attempts yet.</li>
        {/each}
      </ol>
    {:else}
      <p class="empty">Click any car on the panel to follow one job through its attempts.</p>
    {/if}
  </section>

  <section aria-labelledby="ins-dlq">
    <div class="head">
      <h2 id="ins-dlq" class="label">Dead-letter queue <span class="num count">{dlq.length}</span></h2>
      <button class="key small" onclick={onredrive} disabled={dlq.length === 0}>Redrive all</button>
    </div>
    {#if recentDlq.length}
      <ul class="dlq">
        {#each recentDlq as d (d.id)}
          <li>
            <button onclick={() => onselect(d.id)} aria-pressed={job?.id === d.id}>
              <span class="num">#{d.id}</span>
              <span class="muted">{d.attempts.length} tries</span>
              <span class="reason">{OUTCOME_LABEL[d.attempts[d.attempts.length - 1]?.outcome ?? 'error']}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">Empty. Jobs land here when they run out of attempts.</p>
    {/if}
  </section>

  <section aria-labelledby="ins-log">
    <h2 id="ins-log" class="label">Signal log</h2>
    <ol class="log" aria-live="off">
      {#each log as e (e.seq)}
        <li data-kind={e.kind}><span class="num muted">{clock(e.t)}</span> {e.text}</li>
      {:else}
        <li class="muted">Nothing yet. Press Run.</li>
      {/each}
    </ol>
  </section>
</div>

<style>
  .inspector {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    align-items: start;
  }

  @media (max-width: 1180px) {
    .inspector {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .inspector > section:last-child {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 640px) {
    .inspector {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  section {
    padding: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  h2 {
    margin: 0;
    color: var(--ink);
    font-size: 13px;
  }

  .count {
    color: var(--red);
    margin-left: 4px;
  }

  .close {
    border: 0;
    background: none;
    color: var(--muted);
    font-size: 20px;
    line-height: 1;
    padding: 0 4px;
  }

  .title {
    margin: 0;
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
  }

  .title .num {
    font-size: 18px;
    color: var(--cyan);
  }

  .state[data-state='done'] {
    color: var(--green);
  }

  .state[data-state='dead'],
  .state[data-state='dropped'] {
    color: var(--red);
  }

  .state[data-state='backoff'] {
    color: var(--cyan);
  }

  .state[data-state='running'] {
    color: var(--amber);
  }

  dl {
    margin: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 12px;
  }

  dl div {
    display: grid;
    gap: 0;
  }

  dd {
    margin: 0;
    font-size: 13px;
  }

  .poison {
    margin: 0;
    font-size: 13px;
    color: var(--red);
  }

  .track {
    position: relative;
    height: 12px;
    background: var(--panel-raised);
    border-radius: 2px;
    overflow: hidden;
  }

  .bar {
    position: absolute;
    top: 2px;
    bottom: 2px;
    background: var(--c);
    border-radius: 1px;
  }

  .attempts,
  .log,
  .dlq {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .attempts li {
    display: grid;
    grid-template-columns: 18px 10px 1fr auto;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    padding: 3px 0;
    border-bottom: 1px solid var(--line);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
  }

  .muted {
    color: var(--muted);
  }

  .empty {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .dlq {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 4px;
    max-height: 168px;
    overflow-y: auto;
  }

  .dlq button {
    width: 100%;
    display: grid;
    grid-template-columns: auto auto;
    justify-content: space-between;
    gap: 0 8px;
    text-align: left;
    padding: 5px 8px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--panel-raised);
    font-size: 12px;
  }

  .dlq button[aria-pressed='true'] {
    border-color: var(--cyan);
  }

  .dlq .reason {
    grid-column: 1 / -1;
    color: var(--red);
  }

  .log {
    display: grid;
    gap: 2px;
    max-height: 190px;
    overflow-y: auto;
    font-size: 12.5px;
  }

  .log li[data-kind='fault'] {
    color: var(--red);
  }

  .log li[data-kind='recover'] {
    color: var(--green);
  }

  .log li[data-kind='dead'],
  .log li[data-kind='drop'] {
    color: #ff9a8d;
  }

  .log li[data-kind='redrive'] {
    color: var(--cyan);
  }

  .key.small {
    min-height: 28px;
    font-size: 12px;
  }
</style>
