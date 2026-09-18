export const performanceNodeCounts: readonly number[];
export function makePerformanceFixture(nodeCount: number): [filename: string, contents: string];
export function estimateNodeSizes(
  nodes: Iterable<{ id: string; title: string }>,
): Map<string, { width: number; height: number }>;
