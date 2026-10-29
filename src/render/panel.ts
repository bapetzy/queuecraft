import type { Simulation } from '../engine/simulation';
import type { Job, Worker } from '../engine/types';
import { computeLayout, pointOnPolyline, type Layout, type Pt, type Rect } from './layout';
import { C, FONT_LABEL, FONT_LABEL_LG, FONT_NUM, FONT_NUM_LG, attemptColour } from './palette';

interface Car {
  x: number;
  y: number;
  seen: number;
}

interface Flight {
  path: Pt[];
  t0: number;
  dur: number;
  colour: string;
}

const CAR_W = 9;
const CAR_H = 6;
const MAX_FLIGHTS = 160;

/**
 * Draws one simulation as a mosaic signal-box panel. Owns only visual state
 * (where each car is drawn, short-lived effects); the simulation is read-only here.
 */
export class PanelRenderer {
  private ctx: CanvasRenderingContext2D;
  private layout: Layout | null = null;
  private layoutKey = '';
  private cars = new Map<number, Car>();
  private flights: Flight[] = [];
  private bayFlash = new Map<number, number>();
  private arrivalPulse = 0;
  private lastSeq = 0;
  private frame = 0;
  private cssW = 0;
  private cssH = 0;
  reducedMotion = false;
  selectedId: number | null = null;
  hoverId: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = Math.max(1, Math.floor(cssW));
    this.cssH = Math.max(1, Math.floor(cssH));
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layoutKey = '';
  }

  /** Forget visual state, e.g. after a reset. */
  reset(sim: Simulation): void {
    this.cars.clear();
    this.flights = [];
    this.bayFlash.clear();
    this.lastSeq = sim.lastLogSeq;
  }

  /** Job id of the car (or busy bay) under a point, if any. */
  pick(sim: Simulation, x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = 12;
    for (const [id, car] of this.cars) {
      const d = Math.hypot(car.x - x, car.y - y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    if (best !== null) return best;
    const lay = this.layout;
    if (!lay) return null;
    for (let i = 0; i < lay.bays.length; i++) {
      const b = lay.bays[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        return sim.workers[i]?.jobId ?? null;
      }
    }
    return null;
  }

  draw(sim: Simulation, dtReal: number, nowReal: number): void {
    this.frame++;
    const visibleWorkers = sim.workers.filter((w) => w.state !== 'retired').length;
    const key = `${this.cssW}x${this.cssH}:${visibleWorkers}`;
    if (key !== this.layoutKey || !this.layout) {
      this.layout = computeLayout(this.cssW, this.cssH, visibleWorkers);
      this.layoutKey = key;
    }
    const lay = this.layout;
    this.consumeLog(sim, lay, nowReal);
    this.updateCars(sim, lay, dtReal);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.drawBackground(lay);
    this.drawTracks(sim, lay);
    this.drawBays(sim, lay, nowReal);
    this.drawTerminals(sim, lay, nowReal);
    this.drawCars(sim, lay);
    this.drawFlights(nowReal);
  }

  // --------------------------------------------------------------- state sync

  private consumeLog(sim: Simulation, lay: Layout, nowReal: number): void {
    const entries = sim.logSince(this.lastSeq);
    this.lastSeq = sim.lastLogSeq;
    if (entries.length === 0 || this.reducedMotion) return;
    // At high speed hundreds of events land in one frame; animate a sample.
    const stride = Math.max(1, Math.ceil(entries.length / 40));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.kind === 'arrive') {
        this.arrivalPulse = nowReal;
        continue;
      }
      if (e.kind === 'fail' && e.workerId !== undefined) {
        this.bayFlash.set(e.workerId, nowReal);
        continue;
      }
      if (i % stride !== 0 || this.flights.length >= MAX_FLIGHTS) continue;
      if ((e.kind === 'ok' || e.kind === 'dead') && e.jobId !== undefined) {
        const job = sim.findJob(e.jobId);
        const workerId = job?.attempts[job.attempts.length - 1]?.workerId;
        const bay = workerId === undefined ? undefined : lay.bays[workerId];
        if (!bay) continue;
        const from = { x: bay.x + bay.w - 10, y: bay.y + bay.h / 2 };
        const end = e.kind === 'ok' ? lay.done : lay.dlq;
        this.flights.push({
          path: [from, { x: lay.busR, y: from.y }, { x: lay.busR, y: lay.merge.y }, lay.merge, end],
          t0: nowReal,
          dur: 520,
          colour: e.kind === 'ok' ? C.green : C.red,
        });
      } else if (e.kind === 'drop') {
        this.flights.push({
          path: [lay.queueA, lay.drop],
          t0: nowReal,
          dur: 600,
          colour: C.red,
        });
      }
    }
  }

  private targetFor(sim: Simulation, job: Job, lay: Layout, queueIndex: number): Pt | null {
    if (job.state === 'queued') {
      const dx = lay.queueA.x - lay.queueB.x;
      const dy = lay.queueA.y - lay.queueB.y;
      const len = Math.hypot(dx, dy) || 1;
      const d = queueIndex * lay.spacing + lay.spacing / 2;
      if (d > len - lay.spacing) return null;
      return { x: lay.queueB.x + (dx / len) * d, y: lay.queueB.y + (dy / len) * d };
    }
    if (job.state === 'running' && job.workerId !== null) {
      const bay = lay.bays[job.workerId];
      if (!bay) return null;
      return { x: bay.x + Math.min(30, bay.w * 0.28), y: bay.y + bay.h / 2 - (bay.h > 22 ? 3 : 0) };
    }
    if (job.state === 'backoff') {
      const left = job.backoffMs > 0 ? (job.readyAt - sim.now) / job.backoffMs : 0;
      const p = pointOnPolyline(lay.siding, 1 - Math.min(1, Math.max(0, left)));
      const wobble = ((job.id * 2654435761) % 7) - 3;
      return lay.tall ? { x: p.x + wobble, y: p.y } : { x: p.x, y: p.y + wobble };
    }
    return null;
  }

  private updateCars(sim: Simulation, lay: Layout, dtReal: number): void {
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dtReal * 0.014);
    const frame = this.frame;
    const place = (job: Job, target: Pt) => {
      let car = this.cars.get(job.id);
      if (!car) {
        const fresh = job.state === 'queued' && job.attempts.length === 0;
        const start = fresh && !this.reducedMotion ? lay.source : target;
        car = { x: start.x, y: start.y, seen: frame };
        this.cars.set(job.id, car);
      }
      car.x += (target.x - car.x) * k;
      car.y += (target.y - car.y) * k;
      car.seen = frame;
    };

    const visibleSlots = Math.max(
      0,
      Math.floor(Math.hypot(lay.queueA.x - lay.queueB.x, lay.queueA.y - lay.queueB.y) / lay.spacing) - 1,
    );
    const n = Math.min(sim.queue.length, visibleSlots);
    for (let i = 0; i < n; i++) {
      const job = sim.jobs.get(sim.queue.at(i)!);
      if (!job) continue;
      const t = this.targetFor(sim, job, lay, i);
      if (t) place(job, t);
    }
    for (const w of sim.workers) {
      if (w.jobId === null) continue;
      const job = sim.jobs.get(w.jobId);
      if (!job) continue;
      const t = this.targetFor(sim, job, lay, 0);
      if (t) place(job, t);
    }
    for (const id of sim.backoffJobs) {
      const job = sim.jobs.get(id);
      if (!job) continue;
      const t = this.targetFor(sim, job, lay, 0);
      if (t) place(job, t);
    }
    for (const [id, car] of this.cars) if (car.seen !== frame) this.cars.delete(id);
  }

  // ------------------------------------------------------------------ drawing

  private drawBackground(lay: Layout): void {
    const ctx = this.ctx;
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, lay.w, lay.h);
    // Mosaic panel tiles.
    const tile = lay.tall ? 20 : 24;
    ctx.strokeStyle = C.tile;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (lay.w % tile) / 2; x < lay.w; x += tile) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, lay.h);
    }
    for (let y = (lay.h % tile) / 2; y < lay.h; y += tile) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(lay.w, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  private line(points: Pt[], colour: string, width: number, dash: number[] = []): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.setLineDash(dash);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private label(text: string, x: number, y: number, align: CanvasTextAlign = 'left', colour: string = C.muted, font = FONT_LABEL): void {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  private drawTracks(sim: Simulation, lay: Layout): void {
    const occupied = sim.queue.length > 0;
    // Siding (backoff loop).
    const sidingLive = sim.backoffJobs.size > 0;
    this.line(lay.siding, sidingLive ? 'rgba(124, 200, 255, 0.55)' : C.trackDim, 2, [5, 5]);
    if (lay.tall) {
      const p = lay.siding[2];
      this.label('BACKOFF', p.x - 4, p.y + 13, 'left', sidingLive ? C.cyan : C.muted);
    } else {
      const sl = pointOnPolyline(lay.siding, 0.5);
      this.label('BACKOFF LOOP', sl.x, sl.y + 12, 'center', sidingLive ? C.cyan : C.muted);
    }

    // Source to queue, queue body.
    this.line([lay.source, lay.queueA], C.track, 3);
    this.line([lay.queueA, lay.queueB], occupied ? C.track : C.trackDim, 4);

    // Capacity marker.
    const cap = sim.config.queueCapacity;
    const dx = lay.queueA.x - lay.queueB.x;
    const dy = lay.queueA.y - lay.queueB.y;
    const len = Math.hypot(dx, dy) || 1;
    if (cap > 0 && cap * lay.spacing < len - lay.spacing) {
      const d = cap * lay.spacing;
      const p = { x: lay.queueB.x + (dx / len) * d, y: lay.queueB.y + (dy / len) * d };
      const nx = -dy / len;
      const ny = dx / len;
      this.line([{ x: p.x + nx * 9, y: p.y + ny * 9 }, { x: p.x - nx * 9, y: p.y - ny * 9 }], C.red, 2);
      this.label(`CAP ${cap}`, p.x + (lay.tall ? 12 : 0), p.y + (lay.tall ? 0 : -16), lay.tall ? 'left' : 'center', C.red);
    }

    // Queue label and overflow count.
    const qLabelPos = lay.tall
      ? { x: lay.queueA.x + 10, y: lay.queueA.y + 14 }
      : { x: lay.queueA.x, y: lay.queueA.y - 20 };
    this.label('QUEUE', qLabelPos.x, qLabelPos.y, 'left', C.ink, FONT_LABEL_LG);
    this.label(String(sim.queue.length), qLabelPos.x + (lay.tall ? 0 : 48), qLabelPos.y + (lay.tall ? 15 : 0), 'left', occupied ? C.amber : C.muted, FONT_NUM);
    const slots = Math.max(0, Math.floor(len / lay.spacing) - 1);
    if (sim.queue.length > slots) {
      const more = sim.queue.length - slots;
      const p = lay.tall ? { x: lay.queueA.x + 14, y: lay.queueA.y + 50 } : { x: lay.queueA.x + 2, y: lay.queueA.y + 18 };
      this.label(`+${more} beyond view`, p.x, p.y, 'left', C.amber, FONT_NUM);
    }

    // Fan-out to bays, fan-in to the merge point.
    const ux = -dx / len;
    const uy = -dy / len;
    const stub = { x: lay.queueB.x + ux * 12, y: lay.queueB.y + uy * 12 };
    // Square track diagram: every bay hangs off a bus on each side of the
    // yard, so lines never cut across bays. Bays are drawn on top.
    const { busL, busR } = lay;
    const idle: Pt[][] = [];
    const live: Pt[][] = [];
    lay.bays.forEach((b, i) => {
      const cy = b.y + b.h / 2;
      const into = [lay.queueB, stub, { x: busL, y: stub.y }, { x: busL, y: cy }, { x: b.x, y: cy }];
      const out = [{ x: b.x + b.w, y: cy }, { x: busR, y: cy }, { x: busR, y: lay.merge.y }, lay.merge];
      (sim.workers[i]?.state === 'busy' ? live : idle).push(into, out);
    });
    for (const p of idle) this.line(p, C.trackDim, 1.5);
    for (const p of live) this.line(p, 'rgba(216, 208, 187, 0.6)', 1.5);
    this.line([lay.merge, lay.done], C.track, 3);
    this.line([lay.merge, lay.dlq], sim.dlq.length > 0 ? 'rgba(255, 90, 71, 0.7)' : C.trackDim, 2);
  }

  private drawBays(sim: Simulation, lay: Layout, nowReal: number): void {
    const ctx = this.ctx;
    lay.bays.forEach((b, i) => {
      const w = sim.workers[i];
      if (!w) return;
      const flash = this.bayFlash.get(i);
      const flashing = flash !== undefined && nowReal - flash < 320;
      ctx.fillStyle = flashing ? 'rgba(255, 90, 71, 0.18)' : C.panelRaised;
      roundRect(ctx, b, 3);
      ctx.fill();
      ctx.setLineDash(w.retiring ? [3, 3] : []);
      ctx.strokeStyle = flashing ? C.red : w.state === 'busy' ? 'rgba(255, 181, 71, 0.55)' : C.trackDim;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      const lampR = Math.max(2.5, Math.min(4.5, b.h * 0.13));
      const lx = b.x + lampR + 5;
      const ly = b.y + b.h / 2;
      this.lamp(lx, ly, lampR, lampColour(w, nowReal));
      if (b.w > 90 && b.h > 18) {
        this.label(`W${i + 1}`, b.x + b.w - 6, b.y + 9, 'right', C.muted);
      }

      if (w.state === 'busy' && w.jobId !== null) {
        const job = sim.jobs.get(w.jobId);
        const a = job?.attempts[job.attempts.length - 1];
        if (a) {
          const p = Math.min(1, Math.max(0, (sim.now - a.startedAt) / (a.plannedEnd - a.startedAt || 1)));
          const bx = b.x + lampR * 2 + 10;
          const bw = b.w - (bx - b.x) - 6;
          const by = b.y + b.h - Math.max(4, b.h * 0.18);
          ctx.fillStyle = 'rgba(233, 228, 214, 0.08)';
          ctx.fillRect(bx, by, bw, 2);
          ctx.fillStyle = C.amber;
          ctx.fillRect(bx, by, bw * p, 2);
        }
      } else if (w.state === 'down' && b.w > 70) {
        this.label('DOWN', b.x + b.w / 2 + 6, ly, 'center', C.red);
      }
    });
    if (lay.bays.length) {
      const first = lay.bays[0];
      this.label('WORKERS', first.x, first.y - 12, 'left', C.ink, FONT_LABEL_LG);
    }
  }

  private lamp(x: number, y: number, r: number, colour: string | null): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (colour) {
      ctx.fillStyle = colour;
      ctx.shadowColor = colour;
      ctx.shadowBlur = r * 2.5;
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = '#121a17';
      ctx.fill();
      ctx.strokeStyle = C.trackDim;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawTerminals(sim: Simulation, lay: Layout, nowReal: number): void {
    // Source.
    const pulse = !this.reducedMotion && nowReal - this.arrivalPulse < 120;
    this.lamp(lay.source.x, lay.source.y, 6, pulse ? C.white : sim.config.arrivalRate > 0 ? 'rgba(244, 241, 230, 0.35)' : null);
    if (lay.tall) {
      this.label('IN', lay.source.x - 12, lay.source.y, 'right', C.ink, FONT_LABEL_LG);
    } else {
      this.label('IN', lay.source.x, lay.source.y - 18, 'center', C.ink, FONT_LABEL_LG);
    }

    // Done.
    this.terminal(lay.done, 'DONE', sim.totals.completed, C.green, true, lay.tall);
    // DLQ.
    this.terminal(lay.dlq, 'DLQ', sim.dlq.length, C.red, sim.dlq.length > 0, lay.tall);

    // Drops.
    if (sim.totals.dropped > 0) {
      this.label(`DROPPED ${sim.totals.dropped}`, lay.drop.x, lay.drop.y + 12, lay.tall ? 'left' : 'left', C.red, FONT_NUM);
    }
  }

  private terminal(p: Pt, name: string, count: number, colour: string, lit: boolean, tall: boolean): void {
    const ctx = this.ctx;
    const w = tall ? 64 : 76;
    const h = tall ? 40 : 46;
    const r = { x: p.x - w / 2, y: p.y - h / 2, w, h };
    ctx.fillStyle = C.panelRaised;
    roundRect(ctx, r, 4);
    ctx.fill();
    ctx.strokeStyle = lit ? colour : C.trackDim;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    this.lamp(r.x + 9, r.y + 10, 3.5, lit ? colour : null);
    this.label(name, r.x + 18, r.y + 10, 'left', C.ink);
    this.label(formatCount(count), p.x, r.y + h - 13, 'center', lit ? colour : C.muted, tall ? FONT_NUM : FONT_NUM_LG);
  }

  private drawCars(sim: Simulation, lay: Layout): void {
    const ctx = this.ctx;
    const small = lay.tall;
    const cw = small ? 8 : CAR_W;
    const ch = small ? 5 : CAR_H;
    for (const [id, car] of this.cars) {
      const job = sim.jobs.get(id);
      if (!job) continue;
      const used = job.attempts.length - job.attemptBase + (job.state === 'running' ? 0 : 1);
      ctx.fillStyle = attemptColour(Math.max(1, used));
      ctx.fillRect(Math.round(car.x - cw / 2), Math.round(car.y - ch / 2), cw, ch);
      if (job.poison) {
        ctx.fillStyle = C.panel;
        ctx.fillRect(Math.round(car.x - 1.5), Math.round(car.y - 1.5), 3, 3);
      }
      if (id === this.selectedId || id === this.hoverId) {
        ctx.strokeStyle = id === this.selectedId ? C.cyan : C.ink;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.round(car.x - cw / 2) - 3, Math.round(car.y - ch / 2) - 3, cw + 6, ch + 6);
      }
    }
  }

  private drawFlights(nowReal: number): void {
    const ctx = this.ctx;
    this.flights = this.flights.filter((f) => nowReal - f.t0 < f.dur);
    for (const f of this.flights) {
      const t = (nowReal - f.t0) / f.dur;
      const e = 1 - (1 - t) * (1 - t);
      const p = pointOnPolyline(f.path, e);
      ctx.globalAlpha = 1 - t * 0.6;
      ctx.fillStyle = f.colour;
      ctx.fillRect(Math.round(p.x - 3), Math.round(p.y - 2), 6, 4);
    }
    ctx.globalAlpha = 1;
  }
}

function lampColour(w: Worker, nowReal: number): string | null {
  switch (w.state) {
    case 'busy':
      return w.retiring && Math.floor(nowReal / 400) % 2 === 0 ? null : C.amber;
    case 'idle':
      return 'rgba(91, 227, 157, 0.75)';
    case 'down':
      return Math.floor(nowReal / 300) % 2 === 0 ? C.red : 'rgba(255, 90, 71, 0.35)';
    default:
      return null;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

function formatCount(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
