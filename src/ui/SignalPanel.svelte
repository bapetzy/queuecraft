<script lang="ts">
  import { onMount } from 'svelte';
  import type { Simulation } from '../engine/simulation';
  import { PanelRenderer } from '../render/panel';

  interface Props {
    sim: Simulation;
    selectedId: number | null;
    reducedMotion: boolean;
    onpick: (jobId: number | null) => void;
  }

  let { sim, selectedId, reducedMotion, onpick }: Props = $props();

  let canvas: HTMLCanvasElement;
  let frame: HTMLDivElement;
  let renderer: PanelRenderer | null = null;
  let failed = $state(false);
  let pointer = $state<'default' | 'pointer'>('default');

  /** Called by the app's animation loop. */
  export function draw(dtReal: number, nowReal: number): void {
    if (!renderer) return;
    renderer.selectedId = selectedId;
    renderer.reducedMotion = reducedMotion;
    renderer.draw(sim, dtReal, nowReal);
  }

  export function reset(): void {
    renderer?.reset(sim);
  }

  function local(e: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onClick(e: MouseEvent): void {
    if (!renderer) return;
    const { x, y } = local(e);
    onpick(renderer.pick(sim, x, y));
  }

  function onMove(e: MouseEvent): void {
    if (!renderer) return;
    const { x, y } = local(e);
    const id = renderer.pick(sim, x, y);
    renderer.hoverId = id;
    pointer = id === null ? 'default' : 'pointer';
  }

  function onLeave(): void {
    if (renderer) renderer.hoverId = null;
  }

  onMount(() => {
    try {
      renderer = new PanelRenderer(canvas);
    } catch {
      failed = true;
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      renderer?.resize(width, height);
    });
    ro.observe(frame);
    renderer.reset(sim);
    return () => ro.disconnect();
  });
</script>

<div class="frame" bind:this={frame}>
  {#if failed}
    <p class="fallback">
      This browser could not open a 2D canvas, so the panel cannot be drawn. The numbers and charts
      below still run.
    </p>
  {/if}
  <canvas
    bind:this={canvas}
    style:cursor={pointer}
    onclick={onClick}
    onmousemove={onMove}
    onmouseleave={onLeave}
    aria-hidden="true"
  ></canvas>
  <p class="visually-hidden">
    Signal panel: jobs flow from the source into the queue, through the workers, to done or the
    dead-letter queue. Failed jobs wait on the backoff loop before rejoining the queue. The
    readouts and charts below carry the same numbers.
  </p>
</div>

<style>
  .frame {
    position: relative;
    width: 100%;
    height: 100%;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    text-align: center;
    color: var(--muted);
    z-index: 1;
  }
</style>
