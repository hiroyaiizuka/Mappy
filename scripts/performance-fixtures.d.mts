export const performanceNodeCounts: readonly number[];
export const DEEP_CHAIN_LEVELS: number;
export const IMAGE_EVERY: number;
export interface PerformanceShape { id: string; label: string; covers: string }
export const performanceShapes: readonly PerformanceShape[];
export function makePerformanceFixture(nodeCount: number, shape?: string): [filename: string, contents: string];
export function makeEmbedFixture(): [filename: string, contents: string];
export const MIXED_CHAIN_LEVELS: number;
export const MIXED_BARE_STAGE_EVERY: number;
export const MIXED_FIRST_BARE_STAGE: number;
export function makeMixedFixture(nodeCount: number): [filename: string, contents: string];
export interface PerformanceFixtureEntry { id: string; nodeCount: number; shape: PerformanceShape }
export function performanceFixtureMatrix(): PerformanceFixtureEntry[];
export function estimateNodeSizes(
  nodes: Iterable<{ id: string; title: string }>,
): Map<string, { width: number; height: number }>;
