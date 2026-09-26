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

/**
 * The 2,000-node map note the embed cases use (docs/harness.md E31): the balanced
 * list shape with `mappy: true`, so `![[embed-2000]]` renders as a map without a
 * conversion step. The performance documents themselves stay without frontmatter.
 */
export function makeEmbedFixture() {
  const [, body] = makePerformanceFixture(2000, 'list');
  return ['embed-2000.md', `---\nmappy: true\n---\n${body}`];
}

/** Levels of each chain in a mixed document's deep stages: deeper than any other branch in it. */
export const MIXED_CHAIN_LEVELS = 16;
/** Every this many-th stage of a mixed document has no children (a bare stage on the axis)… */
export const MIXED_BARE_STAGE_EVERY = 9;
/** …starting with this stage (0-based: the 6th), so a 500-node document (13 stages) has one too. */
export const MIXED_FIRST_BARE_STAGE = 5;

/**
 * A timeline-sized document that mixes every shape the layout has to keep apart (docs/harness.md E45, LEV-20):
 * about one first-level stage per 40 nodes, cycling through a deep single chain (MIXED_CHAIN_LEVELS levels),
 * long Japanese titles with an image every third node, many flat siblings, and a mixed branch of long and short
 * titles with images (Vault, Markdown-style and one missing) partway down. Every MIXED_BARE_STAGE_EVERY-th stage from
 * MIXED_FIRST_BARE_STAGE on is bare, every third stage title (the 2nd, 5th, 8th…) is a long sentence, and the third stage carries an image of
 * its own, which widens the band every forest starts from. `mappy: true` with no layout key: the case chooses the layout it opens with.
 * Parses to exactly `nodeCount` nodes; every title starts with its own number, so no two are the same.
 */
export function makeMixedFixture(nodeCount) {
  const stageCount = Math.max(6, Math.round(nodeCount / 40));
  const items = nodeCount - 1 - stageCount;
  if (items < stageCount) throw new Error(`A mixed fixture needs at least ${stageCount * 2 + 1} nodes, not ${nodeCount}`);
  const bare = index => index >= MIXED_FIRST_BARE_STAGE && (index - MIXED_FIRST_BARE_STAGE) % MIXED_BARE_STAGE_EVERY === 0;
  const filled = Array.from({ length: stageCount }, (_, index) => index).filter(index => !bare(index));
  const budgets = new Array(stageCount).fill(0);
  filled.forEach((index, at) => { budgets[index] = Math.floor(items / filled.length) + (at < items % filled.length ? 1 : 0); });
  let number = 0;
  let missing = false;
  const lines = ['---', 'mappy: true', '---', `## 大規模タイムライン（${nodeCount}ノード）`, ''];
  const push = (depth, title, body) => {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- ${title}`);
    if (body) lines.push(`${indent}  ${body}`);
  };
  const MIX = [1, 2, 3, 4, 5, 6, 2, 2, 3, 1];
  budgets.forEach((budget, stage) => {
    number += 1;
    const phrase = PHRASES[stage % PHRASES.length];
    push(0, stage % 3 === 1 ? `${number} 第${stage + 1}段階：${phrase}` : `${number} 第${stage + 1}段階`, stage === 2 ? '![[sample-image.svg|120]]' : '');
    const kind = filled.indexOf(stage) % 4;
    const depths = kind === 1 ? balancedDepths(budget) : [];
    for (let at = 0; at < budget; at += 1) {
      number += 1;
      if (kind === 0) push((at % MIXED_CHAIN_LEVELS) + 1, `${number} 段 ${(at % MIXED_CHAIN_LEVELS) + 1}`);
      else if (kind === 1) push(depths[at] ?? 1, japaneseTitle(number), at % 3 === 2 ? '![[sample-image.svg]]' : '');
      else if (kind === 2) push(1, `${number} 兄弟`);
      else {
        const depth = MIX[at % MIX.length] ?? 1;
        let body = '';
        if (depth === 5) body = '![[sample-image.svg|80]]';
        else if (depth === 3 && at % 20 === 2) body = '![説明](sample-image.svg)';
        else if (depth === 6 && !missing) { body = '![[存在しない画像.png|120]]'; missing = true; }
        push(depth, at % 2 === 0 ? japaneseTitle(number) : `${number} 短い`, body);
      }
    }
  });
  return [`timeline-mixed-${nodeCount}.md`, `${lines.join('\n')}\n`];
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
