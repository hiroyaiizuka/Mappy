export function percentile(values: readonly number[], p: number): number;
export interface Summary { n: number; min: number; p50: number; p95: number; max: number; mean: number }
export function summarize(values: readonly number[]): Summary;
