/**
 * Percentiles for the performance records (nearest-rank, so p95 of ten samples
 * is the tenth largest and never an interpolated value nobody observed).
 */
export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function summarize(values) {
  const finite = values.filter(value => Number.isFinite(value));
  if (finite.length === 0) return { n: 0, min: NaN, p50: NaN, p95: NaN, max: NaN, mean: NaN };
  return {
    n: finite.length,
    min: Math.min(...finite),
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: Math.max(...finite),
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
  };
}

/**
 * Intervals between requestAnimationFrame timestamps. A frame the renderer catches up on hands the same timestamp to
 * the callback queued in it: not a frame of its own, so zero intervals are dropped (E45 and E75 read frames the same way).
 */
export function frameIntervals(frames) {
  return frames.slice(1).map((time, index) => time - frames[index]).filter(interval => interval > 0);
}
