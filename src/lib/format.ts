export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 10_000) return `${(value / 1000).toFixed(0)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

export function clock(simMs: number): string {
  const total = Math.floor(simMs / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const tenths = Math.floor((simMs % 1000) / 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths}`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}
