/**
 * Generated 10/100/500/2,000 node documents. `harness:prepare` writes them into
 * test-vault/Fixtures and the browser harness embeds the same text, so both
 * layers measure identical input.
 */
export const performanceNodeCounts = [10, 100, 500, 2000];

export function makePerformanceFixture(nodeCount) {
  const headings = [`# 講座（${nodeCount}ノード）`];
  for (let index = 1; index < nodeCount; index += 1) {
    headings.push((index - 1) % 20 === 0
      ? `## 第${Math.floor((index - 1) / 20) + 1}節`
      : `### 子ノード ${index}`);
  }
  return [`performance-${nodeCount}.md`, `${headings.join('\n\n')}\n`];
}
