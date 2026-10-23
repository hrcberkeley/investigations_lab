/**
 * Timeline aggregation (Session 6). Pure, no DOM — Node-testable.
 *
 * Bins post timestamps into N equal-width buckets in a single linear pass over
 * the columnar timestamp array (the full dataset — no sampling). Optionally
 * counts a "flagged" sub-series in parallel (posts whose author is suspicious).
 * Posts with no/invalid timestamp (<= 0) are skipped.
 */
export function buildTimelineBins(timestamps, { numBins = 120, flaggedMask = null, indices = null } = {}) {
  const N = indices ? indices.length : (timestamps ? timestamps.length : 0);
  const idxAt = (k) => (indices ? indices[k] : k);

  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < N; k++) {
    const t = timestamps[idxAt(k)];
    if (t > 0) {
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }

  const empty = {
    bins: new Uint32Array(numBins),
    flaggedBins: flaggedMask ? new Uint32Array(numBins) : null,
    min: 0, max: 0, binSize: 0, count: 0, numBins,
  };
  if (!Number.isFinite(min)) return empty;
  if (max === min) max = min + 1; // avoid zero-width range

  const binSize = (max - min) / numBins;
  const bins = new Uint32Array(numBins);
  const flaggedBins = flaggedMask ? new Uint32Array(numBins) : null;
  let count = 0;

  for (let k = 0; k < N; k++) {
    const i = idxAt(k);
    const t = timestamps[i];
    if (t <= 0) continue;
    let b = Math.floor((t - min) / binSize);
    if (b >= numBins) b = numBins - 1;
    else if (b < 0) b = 0;
    bins[b]++;
    count++;
    if (flaggedBins && flaggedMask[i]) flaggedBins[b]++;
  }

  return { bins, flaggedBins, min, max, binSize, count, numBins };
}

// Map a unix-second timestamp to its bin index within a built histogram.
export function timestampToBin(t, min, binSize, numBins) {
  if (binSize <= 0) return 0;
  let b = Math.floor((t - min) / binSize);
  if (b < 0) b = 0;
  else if (b >= numBins) b = numBins - 1;
  return b;
}
