import { Simulation } from './simulation';
import type { FaultKind, FaultSpec, SimConfig } from './types';

/**
 * A run on the panel: the main simulation plus an optional ghost that sees the
 * same seed, the same scripted faults and every fault injected by hand, but
 * runs a different config. Used for "compare with the fix".
 */
export class Lab {
  readonly main: Simulation;
  readonly ghost: Simulation | null;

  constructor(
    config: SimConfig,
    seed: number,
    faults: FaultSpec[] = [],
    ghostConfig: SimConfig | null = null,
  ) {
    this.main = new Simulation(config, seed, faults);
    this.ghost = ghostConfig ? new Simulation(ghostConfig, seed, faults) : null;
  }

  get now(): number {
    return this.main.now;
  }

  advanceBy(ms: number): void {
    const target = this.main.now + Math.max(0, ms);
    this.main.advanceTo(target);
    this.ghost?.advanceTo(target);
  }

  inject(kind: FaultKind, durationMs: number, magnitude?: number): void {
    this.main.scheduleFault({ kind, durationMs, magnitude });
    this.ghost?.scheduleFault({ kind, durationMs, magnitude });
  }

  updateConfig(partial: Partial<SimConfig>): SimConfig {
    return this.main.updateConfig(partial);
  }
}
