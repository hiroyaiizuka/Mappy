/**
 * Generated 10/100/500/2,000 node documents. `harness:prepare` writes them into
 * test-vault/Fixtures and the browser harness embeds the same text, so both
 * layers measure identical input.
 *
 * The node count is what product-plan §6 fixes; the shape is what varies which
 * cost dominates (parse, text measurement, layout width, image loads). Every
 * shape parses to exactly `nodeCount` nodes, so timings compare across shapes.
 */
export const performanceNodeCounts = [10, 100, 500, 2000];

/** Deepest single-file chain the `deep` shape builds; 2 spaces per level keeps lines readable. */
export const DEEP_CHAIN_LEVELS = 40;
/** One image embed every this many nodes in the `links` shape. */
export const IMAGE_EVERY = 5;

export const performanceShapes = [
  { id: 'headings', label: '見出し形式', covers: 'H1 ルート＋20 ノードごとの H2 節＋H3 の子（従来の見出し形式）' },
  { id: 'list', label: 'H2＋リスト（均等な枝）', covers: 'H2 ルートの下に幅優先で均等に分けたリスト。通常の入力形式' },
  { id: 'deep', label: '深い一列の枝', covers: `H2 ルートの下に最大 ${DEEP_CHAIN_LEVELS} 段の一列の枝を並べる。横に長いマップ` },
  { id: 'wide', label: '多数の兄弟', covers: 'H2 ルート直下に全ノードを兄弟として並べる。縦に長いマップ' },
  { id: 'japanese', label: '長い日本語', covers: '均等な枝で、各ノードが 60 字前後の日本語の文。折り返しと文字幅の計測' },
  { id: 'links', label: 'リンク・画像', covers: `均等な枝で、全ノードに内部リンク、${IMAGE_EVERY} ノードごとに本文の画像埋め込み（sample-image.svg）` },
];

const PHRASES = [
  '講座の受講者が最初に取り組む課題と、その評価基準を整理した項目',
  '前回の議論で保留になった論点を再確認し、次の会議までに決める事項',
  '実装の順序と依存関係を見直し、優先度の高い作業から着手する計画',
  '長い文章を含むノードでも折り返しが崩れないことを確認するための例',
  '参考文献と一次資料の所在をまとめ、引用の形式を統一するための手順',
];

function performanceFilename(nodeCount, shape) {
  return shape === 'headings' ? `performance-${nodeCount}.md` : `performance-${nodeCount}-${shape}.md`;
}

function headingsShape(nodeCount) {
  const headings = [`# 講座（${nodeCount}ノード）`];
  for (let index = 1; index < nodeCount; index += 1) {
    headings.push((index - 1) % 20 === 0
      ? `## 第${Math.floor((index - 1) / 20) + 1}節`
      : `### 子ノード ${index}`);
  }
  return `${headings.join('\n\n')}\n`;
}

/**
 * Balanced tree in document (pre-order) depth sequence: children are assigned
 * breadth-first so every level fills before the next, then emitted depth-first
 * because an indented list can only nest under the item just above it. Fanout
 * grows with the count so the depth stays around three.
 */
function balancedDepths(itemCount) {
  const fanout = Math.max(2, Math.ceil(Math.cbrt(itemCount)));
  const children = Array.from({ length: itemCount + 1 }, () => []);
  for (let index = 1; index <= itemCount; index += 1) children[Math.ceil(index / fanout) - 1].push(index);
  const depths = [];
  const pending = children[0].map(index => ({ index, depth: 1 })).reverse();
  while (pending.length > 0) {
    const { index, depth } = pending.pop();
    depths.push(depth);
    for (const child of [...children[index]].reverse()) pending.push({ index: child, depth: depth + 1 });
  }
  return depths;
}

function chainDepths(itemCount) {
  const depths = [];
  for (let index = 0; index < itemCount; index += 1) depths.push((index % DEEP_CHAIN_LEVELS) + 1);
  return depths;
}

function listShape(nodeCount, depths, title, body) {
  const lines = [`## 講座（${nodeCount}ノード）`, ''];
  depths.forEach((depth, index) => {
    const number = index + 1;
    const indent = '  '.repeat(depth - 1);
    lines.push(`${indent}- ${title(number)}`);
    const extra = body?.(number);
    if (extra) lines.push(`${indent}  ${extra}`);
  });
  return `${lines.join('\n')}\n`;
}

function japaneseTitle(number) {
  const phrase = PHRASES[(number - 1) % PHRASES.length] ?? '';
  return `${number} 番目のノード。${phrase}について、担当者と期限を決めて記録する。`;
}

/** Returns `[filename, contents]`; `shape` defaults to the original heading document. */
export function makePerformanceFixture(nodeCount, shape = 'headings') {
  const filename = performanceFilename(nodeCount, shape);
  const items = nodeCount - 1;
  switch (shape) {
    case 'headings':
      return [filename, headingsShape(nodeCount)];
    case 'list':
      return [filename, listShape(nodeCount, balancedDepths(items), number => `ノード ${number}`)];
    case 'deep':
      return [filename, listShape(nodeCount, chainDepths(items), number => `段 ${number}`)];
    case 'wide':
      return [filename, listShape(nodeCount, Array.from({ length: items }, () => 1), number => `兄弟 ${number}`)];
    case 'japanese':
      return [filename, listShape(nodeCount, balancedDepths(items), japaneseTitle)];
    case 'links':
      return [filename, listShape(
        nodeCount, balancedDepths(items),
        number => `ノード ${number} [[heading-document|参照 ${number}]]`,
        number => (number % IMAGE_EVERY === 0 ? '![[sample-image.svg]]' : ''),
      )];
    default:
      throw new Error(`Unknown performance fixture shape: ${shape}`);
  }
}

/** Every count × shape pair, the original heading documents first. */
export function performanceFixtureMatrix() {
  const matrix = [];
  for (const shape of performanceShapes) {
    for (const nodeCount of performanceNodeCounts) {
      matrix.push({ id: shape.id === 'headings' ? `performance-${nodeCount}` : `performance-${nodeCount}-${shape.id}`, nodeCount, shape });
    }
  }
  return matrix;
}

/**
 * Rough stand-in for DOM measurement where there is no DOM (geometry tests, the
 * layout benchmark): 14px per character plus padding, wrapped at the node's 360px
 * maximum width, 22px per line.
 */
export function estimateNodeSizes(nodes) {
  const sizes = new Map();
  for (const node of nodes) {
    const text = Math.max(1, node.title.length) * 14 + 16;
    const lines = Math.ceil(text / 344);
    sizes.set(node.id, { width: Math.min(360, text), height: 22 * lines + 8 });
  }
  return sizes;
}
