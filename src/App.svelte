<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { DEFAULT_CONFIG } from './engine/config';
  import { Lab } from './engine/lab';
  import { SANDBOX_ID, SCENARIOS, findScenario } from './engine/scenarios';
  import type { FaultKind, LogEntry, Sample, SimConfig } from './engine/types';
  import { clock, ms, num, pct } from './lib/format';
  import { decodeShare, encodeShare } from './lib/share';
  import Controls from './ui/Controls.svelte';
  import Inspector from './ui/Inspector.svelte';
  import SignalPanel from './ui/SignalPanel.svelte';
  import StripChart from './ui/StripChart.svelte';

  const SPEEDS = [0.5, 1, 2, 4, 8];
  const LOG_KINDS = new Set(['fault', 'recover', 'dead', 'drop', 'redrive', 'fail']);

  // ---------------------------------------------------------------- initial state
  const shared = decodeShare(typeof location === 'undefined' ? '' : location.hash);
  const first = shared.ok ? null : SCENARIOS[0];

  let scenarioId = $state(shared.ok ? shared.state.scenarioId : first!.id);
  let seed = $state(shared.ok ? shared.state.seed : first!.seed);
  let config = $state<SimConfig>(shared.ok ? shared.state.config : { ...first!.config });
  let modified = $state(shared.ok);
  let compare = $state(false);
  let running = $state(true);
  let speed = $state(1);
  let tick = $state(0);
  let selectedId = $state<number | null>(null);
  let toast = $state<string | null>(
    !shared.ok && shared.reason === 'unreadable'
      ? 'That link could not be read, so the steady-state scenario was loaded instead.'
      : null,
  );
  let reducedMotion = $state(false);
  let panel: SignalPanel | undefined = $state();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const scenario = $derived(findScenario(scenarioId));

  function buildLab(): Lab {
    const sc = findScenario(scenarioId);
    const ghost = compare && sc?.fix ? sc.fix.config : null;
    return new Lab($state.snapshot(config), seed, sc?.faults ?? [], ghost);
  }

  let lab = $state.raw<Lab>(untrack(() => buildLab()));

  // Snapshot of the simulation for the UI, refreshed a few times a second.
  const view = $derived.by(() => {
    void tick;
    const sim = lab.main;
    const stats = sim.stats();
    const log: LogEntry[] = [];
    for (let i = sim.log.length - 1; i >= 0 && log.length < 40; i--) {
      if (LOG_KINDS.has(sim.log[i].kind)) log.push(sim.log[i]);
    }
    return {
      stats,
      log,
      dlq: sim.dlq,
      job: selectedId === null ? null : (sim.findJob(selectedId) ?? null),
      samples: sim.samples,
      ghostSamples: lab.ghost?.samples ?? null,
      ghostStats: lab.ghost?.stats() ?? null,
      version: sim.samples.length ? sim.samples[sim.samples.length - 1].t : 0,
      faults: sim.faults.filter((f) => f.active).map((f) => ({ kind: f.kind, left: f.at + f.durationMs - sim.now })),
    };
  });

  // ------------------------------------------------------------------- actions

  function rebuild(): void {
    lab = buildLab();
    selectedId = null;
    tick++;
    queueMicrotask(() => panel?.reset());
  }

  function loadScenario(id: string): void {
    const sc = findScenario(id);
    if (!sc) return;
    scenarioId = id;
    seed = sc.seed;
    config = { ...sc.config };
    modified = false;
    compare = false;
    running = true;
    rebuild();
  }

  function goSandbox(): void {
    scenarioId = SANDBOX_ID;
    modified = true;
    compare = false;
    config = { ...DEFAULT_CONFIG };
    rebuild();
  }

  function setParam<K extends keyof SimConfig>(key: K, value: SimConfig[K]): void {
    config = lab.updateConfig({ [key]: value } as Partial<SimConfig>);
    modified = true;
    tick++;
  }

  function inject(kind: FaultKind, durationMs: number): void {
    lab.inject(kind, durationMs);
    if (!running) running = true;
    tick++;
  }

  function toggleCompare(): void {
    compare = !compare;
    running = true;
    rebuild();
  }

  function applyFix(): void {
    if (!scenario?.fix) return;
    config = { ...scenario.fix.config };
    modified = true;
    compare = false;
    running = true;
    rebuild();
  }

  function reset(): void {
    rebuild();
  }

  function reroll(): void {
    seed = Math.floor(Math.random() * 1_000_000);
    rebuild();
  }

  function step(): void {
    running = false;
    lab.advanceBy(100);
    tick++;
  }

  function redrive(): void {
    const n = lab.main.redriveDlq();
    if (n) say(`${n} job${n === 1 ? '' : 's'} sent back to the queue with a fresh attempt budget.`);
    tick++;
  }

  function say(text: string): void {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 3800);
  }

  async function share(): Promise<void> {
    const url = location.href.split('#')[0] + encodeShare({ scenarioId, seed, config: $state.snapshot(config) });
    try {
      await navigator.clipboard.writeText(url);
      say('Link copied. It replays this exact run: same seed, same settings.');
    } catch {
      say('Could not reach the clipboard. The link is in the address bar.');
    }
  }

  /** A share link pasted into this tab changes only the hash; load it. */
  function onHashChange(): void {
    const res = decodeShare(location.hash);
    if (res.ok) {
      scenarioId = res.state.scenarioId;
      seed = res.state.seed;
      config = res.state.config;
      modified = true;
      compare = false;
      running = true;
      rebuild();
    } else if (res.reason === 'unreadable') {
      say('That link could not be read, so the steady-state scenario was loaded instead.');
      loadScenario(SCENARIOS[0].id);
    }
  }

  // Keep the address bar in step with the run, so a refresh or a copy replays it.
  $effect(() => {
    const hash = encodeShare({ scenarioId, seed, config: $state.snapshot(config) });
    if (location.hash !== hash) history.replaceState(null, '', hash);
  });

  function onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, button') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      running = !running;
    } else if (e.key === '.') {
      step();
    } else if (e.key === 'r' || e.key === 'R') {
      reset();
    }
  }

  onMount(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const onMq = () => (reducedMotion = mq.matches);
    mq.addEventListener('change', onMq);
    if (toast) say(toast);

    let last = performance.now();
    let lastUi = 0;
    let raf = 0;
    const loop = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (running) lab.advanceBy(dt * speed);
      panel?.draw(dt, now);
      if (now - lastUi > 150) {
        lastUi = now;
        tick++;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener('change', onMq);
    };
  });

  // ------------------------------------------------------------------- charts
  const backlogSeries = [
    { label: 'queue', colour: '#ffb547', get: (s: Sample) => s.queueDepth },
    { label: 'backoff', colour: '#7cc8ff', get: (s: Sample) => s.backoff },
  ];
  const flowSeries = [
    { label: 'done', colour: '#5be39d', get: (s: Sample) => s.completions },
    { label: 'arrived', colour: '#d8d0bb', get: (s: Sample) => s.arrivals },
  ];
  const loadSeries = [
    { label: 'attempts', colour: '#f4f1e6', get: (s: Sample) => s.attempts },
    { label: 'failed', colour: '#ff5a47', get: (s: Sample) => s.failures },
  ];
  const latencySeries = [
    { label: 'p95', colour: '#ffb547', get: (s: Sample) => s.p95 },
    { label: 'p50', colour: '#8c9b94', get: (s: Sample) => s.p50 },
  ];
  const fmtCount = (v: number | null) => (v === null ? '—' : String(Math.round(v)));
  const fmtRate = (v: number | null) => (v === null ? '—' : `${Math.round(v)}/s`);
  const fmtMs = (v: number | null) => ms(v);

  const FAULT_NAME: Record<FaultKind, string> = {
    outage: 'Dependency down',
    slowdown: 'Dependency slow',
    spike: 'Traffic spike',
    crash: 'Workers crashed',
  };
</script>

<svelte:window onkeydown={onKey} onhashchange={onHashChange} />

<div class="app">
  <header class="masthead">
    <div class="brand">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="#22302b" />
        <path d="M5 16h14" stroke="#d8d0bb" stroke-width="3" stroke-linecap="round" />
        <path d="M19 16l6-6M19 16l6 6" stroke="#d8d0bb" stroke-width="2" stroke-linecap="round" />
        <circle cx="26" cy="10" r="2.6" fill="#ffb547" />
        <circle cx="26" cy="22" r="2.6" fill="#5be39d" />
        <rect x="7" y="13.5" width="4" height="5" fill="#f4f1e6" />
      </svg>
      <div>
        <h1>Queuecraft</h1>
        <p class="label">A signal box for job queues</p>
      </div>
    </div>
    <nav class="scenarios" aria-label="Scenarios">
      {#each SCENARIOS as sc (sc.id)}
        <button class="tab" aria-current={scenarioId === sc.id ? 'true' : undefined} onclick={() => loadScenario(sc.id)}>
          {sc.title}
        </button>
      {/each}
      <button class="tab" aria-current={scenarioId === SANDBOX_ID ? 'true' : undefined} onclick={goSandbox}>Sandbox</button>
    </nav>
  </header>

  <main class="stage">
    <div class="main-col">
      <section class="story" aria-live="polite">
        {#if scenario}
          <div class="story-text">
            <p class="label kicker">
              {scenario.kicker}{#if modified}<span class="modified"> · settings changed</span>{/if}
            </p>
            <h2>{scenario.title}</h2>
            <p>{scenario.story}</p>
            <p class="watch"><span class="label">Watch</span> {scenario.watch}</p>
          </div>
          {#if scenario.fix}
            <div class="fix">
              <p class="label">The fix: <span class="fix-name">{scenario.fix.label}</span></p>
              <p class="fix-text">{scenario.fix.explanation}</p>
              <div class="fix-actions">
                <button class="key" aria-pressed={compare} onclick={toggleCompare}>
                  {compare ? 'Comparing with fix' : 'Compare with fix'}
                </button>
                <button class="key" onclick={applyFix}>Apply fix</button>
              </div>
              {#if compare && view.ghostStats}
                <table class="versus">
                  <thead>
                    <tr><th></th><th class="label">This run</th><th class="label fixcol">With fix</th></tr>
                  </thead>
                  <tbody>
                    <tr><th class="label">Done</th><td class="num">{view.stats.completed}</td><td class="num fixcol">{view.ghostStats.completed}</td></tr>
                    <tr><th class="label">DLQ</th><td class="num">{view.stats.inDlq}</td><td class="num fixcol">{view.ghostStats.inDlq}</td></tr>
                    <tr><th class="label">Attempts/job</th><td class="num">{num(view.stats.attemptsPerJob, 2)}</td><td class="num fixcol">{num(view.ghostStats.attemptsPerJob, 2)}</td></tr>
                    <tr><th class="label">p95</th><td class="num">{ms(view.stats.p95)}</td><td class="num fixcol">{ms(view.ghostStats.p95)}</td></tr>
                  </tbody>
                </table>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="story-text">
            <p class="label kicker">Sandbox</p>
            <h2>Your own queue</h2>
            <p>Every setting on the right applies live. Inject faults, change the policy mid-run, and copy a link to share the exact run.</p>
          </div>
        {/if}
      </section>

      <section class="panel-wrap" aria-label="Simulation">
        <div class="transport">
          <button class="key run" onclick={() => (running = !running)} aria-pressed={running}>
            {running ? 'Pause' : 'Run'}
          </button>
          <button class="key" onclick={step} title="Advance 100 ms (key: .)">Step</button>
          <button class="key" onclick={reset} title="Restart with the same seed (key: R)">Reset</button>
          <div class="speeds" role="group" aria-label="Speed">
            {#each SPEEDS as s (s)}
              <button class="key small" aria-pressed={speed === s} onclick={() => (speed = s)}>{s}x</button>
            {/each}
          </div>
          <span class="clock num" aria-label="Simulated time">{clock(view.stats.now)}</span>
          <div class="seed">
            <label class="label" for="seed">Seed</label>
            <input
              id="seed"
              class="num"
              type="number"
              min="0"
              value={seed}
              onchange={(e) => {
                const v = Math.abs(Math.floor(Number(e.currentTarget.value)));
                seed = Number.isFinite(v) ? v % 2 ** 32 : 1;
                rebuild();
              }}
            />
            <button class="key small" onclick={reroll} title="New random seed">New</button>
          </div>
          <button class="key" onclick={share}>Copy link</button>
        </div>

        <div class="panel">
          <SignalPanel bind:this={panel} sim={lab.main} {selectedId} {reducedMotion} onpick={(id) => (selectedId = id)} />
          {#if view.faults.length}
            <div class="banners" role="status">
              {#each view.faults as f, i (i)}
                <span class="banner"><i aria-hidden="true"></i>{FAULT_NAME[f.kind]} <span class="num">{Math.ceil(f.left / 1000)} s</span></span>
              {/each}
            </div>
          {/if}
          {#if !running && view.stats.now === 0}
            <div class="idle"><button class="key run" onclick={() => (running = true)}>Run the simulation</button></div>
          {/if}
          <div class="legend" aria-hidden="true">
            <span><i style:background="var(--white)"></i>1st try</span>
            <span><i style:background="var(--amber)"></i>2nd</span>
            <span><i style:background="#ff8a3d"></i>3rd</span>
            <span><i style:background="var(--red)"></i>4th+</span>
            <span><i class="poison"></i>poison</span>
          </div>
        </div>

        <dl class="readouts">
          <div><dt class="label">Throughput</dt><dd class="num">{num(view.stats.throughput, 1)}<small>/s</small></dd></div>
          <div class:warn={view.stats.queued > 50}><dt class="label">In queue</dt><dd class="num">{view.stats.queued}</dd></div>
          <div><dt class="label">p95 latency</dt><dd class="num">{ms(view.stats.p95)}</dd></div>
          <div class:warn={(view.stats.attemptsPerJob ?? 1) > 1.5}><dt class="label">Attempts/job</dt><dd class="num">{num(view.stats.attemptsPerJob, 2)}</dd></div>
          <div class:warn={view.stats.utilization > 0.9}><dt class="label">Workers busy</dt><dd class="num">{pct(view.stats.utilization)}</dd></div>
          <div class:bad={view.stats.inDlq > 0}><dt class="label">Dead-lettered</dt><dd class="num">{view.stats.inDlq}</dd></div>
          <div class:bad={view.stats.dropped > 0}><dt class="label">Dropped</dt><dd class="num">{view.stats.dropped}</dd></div>
        </dl>
      </section>

      <section class="charts" aria-label="Charts, last 90 seconds">
        <StripChart title="Backlog" unit="jobs" samples={view.samples} ghost={view.ghostSamples} series={backlogSeries} version={view.version} format={fmtCount} />
        <StripChart title="Flow" unit="jobs per second" samples={view.samples} ghost={view.ghostSamples} series={flowSeries} version={view.version} format={fmtRate} />
        <StripChart title="Work done" unit="attempts per second" samples={view.samples} ghost={view.ghostSamples} series={loadSeries} version={view.version} format={fmtRate} />
        <StripChart title="Latency, 10 s window" unit="milliseconds" samples={view.samples} ghost={view.ghostSamples} series={latencySeries} version={view.version} format={fmtMs} />
      </section>

      <Inspector
        job={view.job}
        now={view.stats.now}
        dlq={view.dlq}
        log={view.log}
        serviceTimeMs={config.serviceTimeMs}
        onselect={(id) => (selectedId = id)}
        onredrive={redrive}
      />
    </div>

    <aside class="side-col">
      <Controls config={config} activeFaults={view.stats.activeFaults} onchange={setParam} oninject={inject} />
    </aside>
  </main>

  <footer class="foot">
    <p>
      Deterministic discrete-event simulation. Same seed and settings, same run. Keys: <kbd>Space</kbd> run/pause,
      <kbd>.</kbd> step, <kbd>R</kbd> reset.
    </p>
  </footer>

  {#if toast}
    <div class="toast" role="status">{toast}</div>
  {/if}
</div>

<style>
  .app {
    max-width: 1480px;
    margin: 0 auto;
    padding: 16px 20px 32px;
  }

  .masthead {
    display: flex;
    align-items: center;
    gap: 16px 28px;
    flex-wrap: wrap;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 16px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  h1 {
    margin: 0;
    font-family: var(--font-label);
    font-weight: 700;
    font-size: 24px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    line-height: 1;
  }

  .brand .label {
    margin: 3px 0 0;
    font-size: 11px;
  }

  .scenarios {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .tab {
    border: 1px solid transparent;
    background: none;
    padding: 6px 10px;
    border-radius: var(--radius);
    font-family: var(--font-label);
    font-weight: 600;
    font-size: 14px;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .tab:hover {
    color: var(--ink);
  }

  .tab[aria-current='true'] {
    color: var(--ink);
    border-color: var(--line-strong);
    background: var(--panel-raised);
    box-shadow: inset 0 -2px 0 var(--amber);
  }

  .stage {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 16px;
    align-items: start;
  }

  .main-col,
  .side-col {
    display: grid;
    gap: 14px;
    min-width: 0;
  }

  /* Story card */
  .story {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
    gap: 14px 24px;
    padding: 16px 18px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  .story h2 {
    margin: 2px 0 6px;
    font-family: var(--font-label);
    font-weight: 700;
    font-size: 26px;
    letter-spacing: 0.02em;
    line-height: 1.05;
  }

  .story p {
    margin: 0 0 8px;
    max-width: 62ch;
  }

  .kicker {
    margin: 0;
    color: var(--amber);
  }

  .modified {
    color: var(--muted);
  }

  .watch {
    color: var(--muted);
  }

  .watch .label {
    color: var(--ink);
    margin-right: 4px;
  }

  .fix {
    border-left: 1px solid var(--line);
    padding-left: 20px;
    display: grid;
    align-content: start;
    gap: 8px;
  }

  .fix p {
    margin: 0;
  }

  .fix-name {
    color: var(--cyan);
  }

  .fix-text {
    font-size: 14px;
    color: var(--muted);
  }

  .fix-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .versus {
    border-collapse: collapse;
    font-size: 13px;
    width: 100%;
    max-width: 340px;
  }

  .versus th,
  .versus td {
    padding: 3px 6px;
    text-align: right;
    border-bottom: 1px solid var(--line);
  }

  .versus th:first-child {
    text-align: left;
    padding-left: 0;
  }

  .fixcol {
    color: var(--cyan);
  }

  /* Panel */
  .panel-wrap {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .transport {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    background: #18211e;
  }

  .run {
    min-width: 76px;
  }

  .run[aria-pressed='true'] {
    color: var(--green);
    border-color: var(--green);
  }

  .run[aria-pressed='false'] {
    color: var(--amber);
    border-color: var(--amber);
  }

  .speeds {
    display: flex;
    gap: 2px;
  }

  .key.small {
    min-height: 30px;
    padding: 0 8px;
    font-size: 12px;
  }

  .clock {
    font-size: 18px;
    color: var(--ink);
    margin-left: auto;
    min-width: 92px;
    text-align: right;
  }

  .seed {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .seed input {
    width: 92px;
    min-height: 30px;
    padding: 0 8px;
    background: var(--bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    font-size: 13px;
  }

  .panel {
    position: relative;
    height: clamp(360px, 42vw, 500px);
  }

  .banners {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: center;
    pointer-events: none;
  }

  .banner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--red);
    border-radius: 3px;
    background: rgba(255, 90, 71, 0.12);
    color: var(--red);
    font-family: var(--font-label);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-size: 12px;
  }

  .banner i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
    box-shadow: 0 0 8px var(--red);
    animation: blink 0.9s steps(2) infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0.25;
    }
  }

  .idle {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(20, 28, 25, 0.55);
  }

  .legend {
    position: absolute;
    left: 12px;
    bottom: 8px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    font-family: var(--font-label);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    pointer-events: none;
  }

  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .legend i {
    width: 9px;
    height: 6px;
    display: inline-block;
  }

  .legend i.poison {
    background: radial-gradient(circle, var(--panel) 0 1.5px, var(--white) 1.6px);
  }

  .readouts {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    border-top: 1px solid var(--line);
  }

  .readouts div {
    padding: 10px 12px;
    border-right: 1px solid var(--line);
    min-width: 0;
  }

  .readouts div:last-child {
    border-right: 0;
  }

  .readouts dd {
    margin: 2px 0 0;
    font-size: 20px;
    color: var(--ink);
    white-space: nowrap;
  }

  .readouts small {
    font-size: 12px;
    color: var(--muted);
    margin-left: 2px;
  }

  .readouts .warn dd {
    color: var(--amber);
  }

  .readouts .bad dd {
    color: var(--red);
  }

  .charts {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  .foot {
    margin-top: 20px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 13px;
  }

  .foot p {
    margin: 0;
  }

  kbd {
    font-family: var(--font-num);
    font-size: 11px;
    padding: 1px 5px;
    border: 1px solid var(--line-strong);
    border-radius: 3px;
    color: var(--ink);
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    max-width: min(520px, calc(100vw - 32px));
    padding: 10px 14px;
    background: var(--panel-raised);
    border: 1px solid var(--cyan);
    border-radius: var(--radius);
    font-size: 14px;
    z-index: 10;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  }

  @media (max-width: 1180px) {
    .stage {
      grid-template-columns: minmax(0, 1fr) 300px;
    }

    .charts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .readouts {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .readouts div {
      border-bottom: 1px solid var(--line);
    }
  }

  @media (max-width: 900px) {
    .stage {
      grid-template-columns: minmax(0, 1fr);
    }

    .story {
      grid-template-columns: minmax(0, 1fr);
    }

    .fix {
      border-left: 0;
      padding-left: 0;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }

    .side-col :global(.controls) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
    }
  }

  @media (max-width: 640px) {
    .app {
      padding: 12px 16px 24px;
    }

    .scenarios {
      flex-wrap: nowrap;
      overflow-x: auto;
      margin: 0 -16px;
      padding: 0 16px 4px;
      width: calc(100% + 32px);
      scrollbar-width: none;
    }

    .tab {
      white-space: nowrap;
    }

    .story h2 {
      font-size: 22px;
    }

    .panel {
      height: 480px;
    }

    .banners {
      left: auto;
      right: 10px;
      transform: none;
      justify-content: flex-end;
    }

    .clock {
      margin-left: 0;
    }

    .seed {
      order: 10;
    }

    .readouts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .charts,
    .side-col :global(.controls) {
      grid-template-columns: minmax(0, 1fr);
    }

    .legend {
      gap: 6px;
      font-size: 10px;
    }
  }
</style>
