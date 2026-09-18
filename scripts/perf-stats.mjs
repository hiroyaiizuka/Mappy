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
