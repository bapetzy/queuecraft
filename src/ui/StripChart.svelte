<script lang="ts" module>
  import type { Sample } from '../engine/types';

  export interface Series {
    label: string;
    colour: string;
    get: (s: Sample) => number | null;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    title: string;
    unit: string;
    samples: Sample[];
    ghost: Sample[] | null;
    series: Series[];
    /** Changes whenever new samples arrive; triggers a redraw. */
    version: number;
    format: (v: number | null) => string;
    window?: number;
  }

  let { title, unit, samples, ghost, series, version, format, window = 90 }: Props = $props();

  let canvas: HTMLCanvasElement;
  let box: HTMLDivElement;
  let size = $state({ w: 0, h: 0 });

  const latest = $derived.by(() => {
    void version;
    const s = samples[samples.length - 1];
    return s ? series.map((x) => x.get(s)) : series.map(() => null);
  });
  const ghostLatest = $derived.by(() => {
    void version;
    const s = ghost?.[ghost.length - 1];
    return s ? series[0].get(s) : null;
  });

  function draw(): void {
    const ctx = canvas?.getContext('2d');
    if (!ctx || size.w === 0) return;
    const dpr = Math.min(2, window_dpr());
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);

    const view = samples.slice(-window);
    const gview = ghost ? ghost.slice(-window) : [];
    let max = 1;
    for (const s of view) for (const x of series) max = Math.max(max, x.get(s) ?? 0);
    for (const s of gview) max = Math.max(max, series[0].get(s) ?? 0);
    max = niceCeil(max * 1.1);

    // Grid.
    ctx.strokeStyle = 'rgba(233, 228, 214, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = Math.round((h * i) / 4) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    const xAt = (i: number) => (window <= 1 ? w : (i / (window - 1)) * w);
    const yAt = (v: number) => h - 2 - (v / max) * (h - 6);
    const plot = (data: Sample[], get: Series['get'], colour: string, dash: number[], width: number) => {
      const offset = window - data.length;
      ctx.beginPath();
      let started = false;
      data.forEach((s, i) => {
        const v = get(s);
        if (v === null) {
          started = false;
          return;
        }
        const x = xAt(i + offset);
        const y = yAt(v);
        if (!started) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        started = true;
      });
      ctx.setLineDash(dash);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.setLineDash([]);
    };

    if (gview.length) plot(gview, series[0].get, 'rgba(124, 200, 255, 0.9)', [4, 3], 1.5);
    for (let i = series.length - 1; i >= 0; i--) {
      plot(view, series[i].get, series[i].colour, [], i === 0 ? 2 : 1.25);
    }

    ctx.font = '400 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(140, 155, 148, 0.9)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillText(format(max), w - 2, 2);
  }

  function window_dpr(): number {
    return typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  }

  function niceCeil(v: number): number {
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  $effect(() => {
    void version;
    void size.w;
    void size.h;
    void ghost;
    draw();
  });

  onMount(() => {
    const ro = new ResizeObserver(([e]) => {
      size = { w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) };
    });
    ro.observe(box);
    return () => ro.disconnect();
  });
</script>

<figure class="chart">
  <figcaption>
    <span class="label title">{title}</span>
    <span class="values">
      {#each series as s, i (s.label)}
        <span class="val" style:--c={s.colour}>
          <i aria-hidden="true"></i>
          <span class="label">{s.label}</span>
          <span class="num">{format(latest[i])}</span>
        </span>
      {/each}
      {#if ghost}
        <span class="val" style:--c="var(--cyan)">
          <i class="dash" aria-hidden="true"></i>
          <span class="label">fix</span>
          <span class="num">{format(ghostLatest)}</span>
        </span>
      {/if}
    </span>
  </figcaption>
  <div class="plot" bind:this={box}>
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
    <span class="visually-hidden">{title} over the last {window} seconds, in {unit}.</span>
  </div>
</figure>

<style>
  .chart {
    margin: 0;
    padding: 10px 12px 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: grid;
    grid-template-rows: auto 1fr;
    gap: 6px;
    min-width: 0;
  }

  figcaption {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 2px 10px;
    align-items: baseline;
  }

  .title {
    color: var(--ink);
  }

  .values {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
  }

  .val {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }

  .val .label {
    font-size: 11px;
  }

  .val i {
    width: 10px;
    height: 2px;
    background: var(--c);
  }

  .val i.dash {
    background: repeating-linear-gradient(to right, var(--c) 0 3px, transparent 3px 5px);
  }

  .val .num {
    color: var(--c);
  }

  .plot {
    position: relative;
    height: 96px;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
</style>
