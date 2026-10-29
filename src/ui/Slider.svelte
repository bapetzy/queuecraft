<script lang="ts">
  interface Props {
    id: string;
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    display: string;
    hint?: string;
    onchange: (value: number) => void;
  }

  let { id, label, value, min, max, step, display, hint, onchange }: Props = $props();

  const fill = $derived(((value - min) / (max - min || 1)) * 100);
</script>

<div class="slider">
  <div class="top">
    <label class="label" for={id}>{label}</label>
    <output class="num" for={id}>{display}</output>
  </div>
  <input
    {id}
    type="range"
    {min}
    {max}
    {step}
    {value}
    style:--fill="{fill}%"
    oninput={(e) => onchange(Number(e.currentTarget.value))}
    aria-describedby={hint ? `${id}-hint` : undefined}
  />
  {#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
</div>

<style>
  .slider {
    display: grid;
    gap: 4px;
  }

  .top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }

  output {
    font-size: 13px;
    color: var(--ink);
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.35;
  }

  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 22px;
    background: transparent;
    margin: 0;
  }

  input[type='range']::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--track) var(--fill), var(--line) var(--fill));
  }

  input[type='range']::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--track) var(--fill), var(--line) var(--fill));
  }

  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 18px;
    margin-top: -7px;
    border-radius: 2px;
    background: var(--white);
    border: 2px solid var(--panel);
    box-shadow: 0 0 0 1px var(--line-strong);
  }

  input[type='range']::-moz-range-thumb {
    width: 10px;
    height: 16px;
    border-radius: 2px;
    background: var(--white);
    border: 2px solid var(--panel);
  }
</style>
