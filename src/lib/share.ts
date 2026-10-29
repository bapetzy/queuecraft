import { DEFAULT_CONFIG, sanitizeConfig } from '../engine/config';
import { SANDBOX_ID, findScenario } from '../engine/scenarios';
import type { SimConfig } from '../engine/types';

export interface ShareState {
  scenarioId: string;
  seed: number;
  config: SimConfig;
}

const PREFIX = '#run=';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeShare(state: ShareState): string {
  const payload = { v: 1, s: state.scenarioId, seed: state.seed, c: state.config };
  return PREFIX + toBase64Url(JSON.stringify(payload));
}

export type DecodeResult =
  | { ok: true; state: ShareState }
  | { ok: false; reason: 'empty' | 'unreadable' };

/** Read a share hash. Never throws; bad input comes back as `ok: false`. */
export function decodeShare(hash: string): DecodeResult {
  if (!hash || !hash.startsWith(PREFIX)) return { ok: false, reason: 'empty' };
  try {
    const raw = JSON.parse(fromBase64Url(hash.slice(PREFIX.length))) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || raw.v !== 1) return { ok: false, reason: 'unreadable' };
    const scenarioId =
      typeof raw.s === 'string' && (raw.s === SANDBOX_ID || findScenario(raw.s)) ? raw.s : SANDBOX_ID;
    const seedNum = Number(raw.seed);
    const seed = Number.isFinite(seedNum) ? Math.abs(Math.floor(seedNum)) % 2 ** 32 : 1;
    const base = findScenario(scenarioId)?.config ?? DEFAULT_CONFIG;
    return { ok: true, state: { scenarioId, seed, config: sanitizeConfig(raw.c, base) } };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
