export const performanceNodeCounts: readonly number[];
export const DEEP_CHAIN_LEVELS: number;
export const IMAGE_EVERY: number;
export interface PerformanceShape { id: string; label: string; covers: string }
export const performanceShapes: readonly PerformanceShape[];
export function makePerformanceFixture(nodeCount: number, shape?: string): [filename: string, contents: string];
export interface PerformanceFixtureEntry { id: string; nodeCount: number; shape: PerformanceShape }
export function performanceFixtureMatrix(): PerformanceFixtureEntry[];
