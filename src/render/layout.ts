export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  w: number;
  h: number;
  tall: boolean;
  source: Pt;
  /** Queue entrance (tail). */
  queueA: Pt;
  /** Queue head, next to the workers. */
  queueB: Pt;
  spacing: number;
  bays: Rect[];
  /** Vertical buses either side of the worker yard. */
  busL: number;
  busR: number;
  merge: Pt;
  done: Pt;
  dlq: Pt;
  drop: Pt;
  /** Backoff loop, from the workers back to the queue entrance. */
  siding: Pt[];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function pointOnPolyline(points: Pt[], t: number): Pt {
  if (points.length === 1) return points[0];
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lens.push(l);
    total += l;
  }
  let d = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const f = lens[i] === 0 ? 0 : d / lens[i];
      return {
        x: lerp(points[i].x, points[i + 1].x, Math.min(1, f)),
        y: lerp(points[i].y, points[i + 1].y, Math.min(1, f)),
      };
    }
    d -= lens[i];
  }
  return points[points.length - 1];
}

/** Arrange `n` bays in `area`, picking the column count that gives the tallest bays. */
export function layoutBays(n: number, area: Rect): Rect[] {
  if (n <= 0) return [];
  const gx = 10;
  const gy = 6;
  let best = { cols: 1, bw: 0, bh: 0 };
  for (let cols = 1; cols <= 4; cols++) {
    const rows = Math.ceil(n / cols);
    const bw = (area.w - (cols - 1) * gx) / cols;
    const bh = Math.min((area.h - (rows - 1) * gy) / rows, bw / 2.4, 40);
    if (bw < 56) continue;
    if (bh > best.bh + 0.5) best = { cols, bw, bh };
  }
  if (best.bh === 0) {
    const rows = n;
    best = { cols: 1, bw: area.w, bh: Math.max(8, (area.h - (rows - 1) * gy) / rows) };
  }
  const { cols, bw, bh } = best;
  const rows = Math.ceil(n / cols);
  const usedH = rows * bh + (rows - 1) * gy;
  const top = area.y + (area.h - usedH) / 2;
  const bays: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / rows);
    const r = i % rows;
    bays.push({ x: area.x + c * (bw + gx), y: top + r * (bh + gy), w: bw, h: bh });
  }
  return bays;
}

function withBuses(l: Omit<Layout, 'busL' | 'busR'>, area: Rect): Layout {
  return { ...l, busL: Math.round(area.x - 12), busR: Math.round(area.x + area.w + 12) };
}

export function computeLayout(w: number, h: number, workerCount: number): Layout {
  const tall = w < 620;
  const pad = tall ? 16 : 28;
  if (!tall) {
    const midY = Math.round(h * 0.42);
    const queueA = { x: pad + 64, y: midY };
    const queueB = { x: Math.round(w * 0.5), y: midY };
    const area = { x: w * 0.565, y: h * 0.08, w: w * 0.235, h: h * 0.68 };
    const sidingY = Math.round(h * 0.88);
    const sidingX = Math.round(w * 0.535);
    return withBuses({
      w,
      h,
      tall,
      source: { x: pad + 18, y: midY },
      queueA,
      queueB,
      spacing: 13,
      bays: layoutBays(workerCount, area),
      merge: { x: Math.round(w * 0.865), y: midY },
      done: { x: w - pad - 34, y: midY },
      dlq: { x: w - pad - 34, y: Math.round(h * 0.8) },
      drop: { x: queueA.x + 6, y: midY + 54 },
      siding: [
        { x: sidingX, y: area.y + area.h + 6 },
        { x: sidingX, y: sidingY },
        { x: queueA.x + 26, y: sidingY },
        { x: queueA.x + 26, y: midY + 16 },
      ],
    }, area);
  }
  const colX = Math.round(w * 0.2);
  const queueA = { x: colX, y: pad + 52 };
  const queueB = { x: colX, y: Math.round(h * 0.6) };
  const area = { x: w * 0.4, y: pad + 30, w: w * 0.6 - pad - 16, h: h * 0.58 };
  const sideX = pad + 6;
  const busR = Math.round(area.x + area.w + 12);
  return withBuses({
    w,
    h,
    tall,
    source: { x: colX, y: pad + 14 },
    queueA,
    queueB,
    spacing: 12,
    bays: layoutBays(workerCount, area),
    merge: { x: busR, y: Math.round(h * 0.76) },
    done: { x: Math.round(w * 0.8), y: Math.round(h * 0.89) },
    dlq: { x: Math.round(w * 0.5), y: Math.round(h * 0.89) },
    drop: { x: colX + 30, y: queueA.y - 4 },
    siding: [
      { x: colX - 10, y: queueB.y + 22 },
      { x: colX - 10, y: Math.round(h * 0.7) },
      { x: sideX, y: Math.round(h * 0.7) },
      { x: sideX, y: queueA.y },
      { x: colX - 12, y: queueA.y },
    ],
  }, area);
}
