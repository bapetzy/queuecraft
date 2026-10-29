/**
 * Mosaic signal-box panel colours. Mirrored as CSS custom properties in
 * app.css; keep the two in step.
 */
export const C = {
  panel: '#1b2522',
  panelRaised: '#22302b',
  tile: 'rgba(233, 228, 214, 0.035)',
  track: '#d8d0bb',
  trackDim: '#4f5f58',
  ink: '#e9e4d6',
  muted: '#8c9b94',
  amber: '#ffb547',
  green: '#5be39d',
  red: '#ff5a47',
  cyan: '#7cc8ff',
  white: '#f4f1e6',
  violet: '#c49bff',
} as const;

/** Car colour by how many attempts a job has used. */
export function attemptColour(used: number): string {
  if (used <= 1) return C.white;
  if (used === 2) return C.amber;
  if (used === 3) return '#ff8a3d';
  return C.red;
}

export const FONT_LABEL = '600 11px "Barlow Condensed", "Arial Narrow", sans-serif';
export const FONT_LABEL_LG = '600 13px "Barlow Condensed", "Arial Narrow", sans-serif';
export const FONT_NUM = '500 12px "IBM Plex Mono", ui-monospace, monospace';
export const FONT_NUM_LG = '500 20px "IBM Plex Mono", ui-monospace, monospace';
