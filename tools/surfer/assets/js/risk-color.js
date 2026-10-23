/**
 * Risk-score colour ramp (Session 4). Pure, no DOM — Node-testable.
 *
 * Flagged accounts interpolate from amber (low score) through orange to deep
 * red (high score) so investigators can triage by severity at a glance instead
 * of every flagged node being the same flat red. Unflagged nodes stay muted.
 *
 * Stops are [score, [r, g, b]]; scores below the first / above the last clamp.
 */
export const RISK_STOPS = [
  [30, [245, 158, 11]],  // #f59e0b amber
  [50, [249, 115, 22]],  // #f97316 orange
  [70, [220, 38, 38]],   // #dc2626 red
  [100, [127, 29, 29]],  // #7f1d1d deep red
];

export const UNFLAGGED_COLOR = '#d1d5db';

function toHex(rgb) {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export function riskColorRgb(score) {
  const s = Number.isFinite(score) ? score : 0;
  const stops = RISK_STOPS;
  if (s <= stops[0][0]) return stops[0][1].slice();
  if (s >= stops[stops.length - 1][0]) return stops[stops.length - 1][1].slice();
  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, c0] = stops[i];
    const [s1, c1] = stops[i + 1];
    if (s >= s0 && s <= s1) {
      const t = (s - s0) / (s1 - s0);
      return [0, 1, 2].map(k => c0[k] + (c1[k] - c0[k]) * t);
    }
  }
  return stops[stops.length - 1][1].slice();
}

export function riskColor(score) {
  return toHex(riskColorRgb(score));
}

// Readable text colour for a score-coloured pill: dark on the light amber end,
// white once the ramp darkens toward red.
export function riskTextColor(score) {
  const [r, g, b] = riskColorRgb(score);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#1f2937' : '#ffffff';
}
