import { describe, expect, it } from 'vitest';
import { percentile, summarize } from '../../scripts/perf-stats.mjs';

describe('perf-stats', () => {
  it('uses nearest-rank percentiles, so p95 of ten samples is the tenth largest', () => {
    const values = [5, 3, 9, 1, 7, 2, 8, 6, 4, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 100)).toBe(10);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNaN();
  });

  it('never interpolates a value nobody observed', () => {
    const values = [10, 20, 30, 40];
    expect(percentile(values, 50)).toBe(20);
    expect(percentile(values, 95)).toBe(40);
    expect(percentile(values, 1)).toBe(10);
  });

  it('summarises finite samples only', () => {
    const summary = summarize([3, NaN, 1, Infinity, 2]);
    expect(summary).toEqual({ n: 3, min: 1, p50: 2, p95: 3, max: 3, mean: 2 });
    expect(summarize([]).n).toBe(0);
    expect(summarize([]).p95).toBeNaN();
  });
});
