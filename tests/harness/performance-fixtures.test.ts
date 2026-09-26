import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/core/markdown';
import { nodeBody } from '../../src/core/body';
import { attachmentMarkdown } from '../../src/core/attachments';
import {
  DEEP_CHAIN_LEVELS, IMAGE_EVERY, MIXED_BARE_STAGE_EVERY, MIXED_CHAIN_LEVELS, MIXED_FIRST_BARE_STAGE, makeEmbedFixture, makeMixedFixture, makePerformanceFixture, performanceFixtureMatrix, performanceNodeCounts, performanceShapes,
} from '../../scripts/performance-fixtures.mjs';

function parse(nodeCount: number, shape: string) {
  const [filename, source] = makePerformanceFixture(nodeCount, shape);
  return { filename, source, doc: parseMarkdown(source, filename.replace(/\.md$/u, '')) };
}

describe('performance fixture shapes', () => {
  it('keeps the original heading document as the default shape and file name', () => {
    const [filename, source] = makePerformanceFixture(100);
    expect(filename).toBe('performance-100.md');
    expect(source.startsWith('# 講座（100ノード）\n\n## 第1節\n\n### 子ノード 2\n')).toBe(true);
    expect(makePerformanceFixture(100, 'headings')).toEqual([filename, source]);
  });

  it('parses every count × shape to exactly the requested node count', () => {
    expect(performanceNodeCounts).toEqual([10, 100, 500, 2000]);
    expect(performanceShapes.map(shape => shape.id)).toEqual(['headings', 'list', 'deep', 'wide', 'japanese', 'links']);
    for (const { id, nodeCount, shape } of performanceFixtureMatrix()) {
      const { filename, doc } = parse(nodeCount, shape.id);
      expect(filename, id).toBe(shape.id === 'headings' ? `performance-${nodeCount}.md` : `performance-${nodeCount}-${shape.id}.md`);
      expect(doc.nodes, id).toHaveLength(nodeCount);
      expect(doc.root.children, id).toHaveLength(1);
      expect(doc.format, id).toBe(shape.id === 'headings' ? 'headings' : 'list');
    }
  });

  it('derives the 2,000-node embed target from the balanced list shape with `mappy: true`, leaving the performance documents bare', () => {
    const [filename, source] = makeEmbedFixture();
    expect(filename).toBe('embed-2000.md');
    expect(source.startsWith('---\nmappy: true\n---\n## 講座（2000ノード）\n')).toBe(true);
    expect(parseMarkdown(source, 'embed-2000').nodes).toHaveLength(2000);
    expect(makePerformanceFixture(2000, 'list')[1].startsWith('---')).toBe(false);
  });

  it('gives every shape a distinct file, and the matrix lists the heading documents first', () => {
    const matrix = performanceFixtureMatrix();
    const ids = matrix.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 4)).toEqual(['performance-10', 'performance-100', 'performance-500', 'performance-2000']);
    expect(ids).toContain('performance-2000-japanese');
  });

  it('builds a single-file chain of at most DEEP_CHAIN_LEVELS levels for the deep shape', () => {
    const { doc } = parse(2000, 'deep');
    const depth = Math.max(...doc.nodes.map(node => node.level)) - 2;
    expect(depth).toBe(DEEP_CHAIN_LEVELS);
    const chains = doc.root.children[0]?.children ?? [];
    expect(chains.length).toBe(Math.ceil(1999 / DEEP_CHAIN_LEVELS));
    for (const chain of chains.slice(0, -1)) {
      let node = chain;
      let length = 1;
      while (node.children.length === 1) { node = node.children[0]!; length += 1; }
      expect(node.children).toHaveLength(0);
      expect(length).toBe(DEEP_CHAIN_LEVELS);
    }
    const small = parse(10, 'deep').doc;
    expect(Math.max(...small.nodes.map(node => node.level)) - 2).toBe(9);
  });

  it('puts every node directly under the root for the wide shape', () => {
    const { doc } = parse(500, 'wide');
    expect(doc.root.children[0]?.children).toHaveLength(499);
    expect(doc.nodes.every(node => node.level <= 3)).toBe(true);
  });

  it('keeps the balanced shapes around three levels deep with a growing fanout', () => {
    for (const count of [100, 500, 2000]) {
      const { doc } = parse(count, 'list');
      const depth = Math.max(...doc.nodes.map(node => node.level)) - 2;
      expect(depth, `${count}`).toBeGreaterThanOrEqual(2);
      expect(depth, `${count}`).toBeLessThanOrEqual(4);
      const fanout = Math.ceil(Math.cbrt(count - 1));
      expect(doc.root.children[0]?.children).toHaveLength(fanout);
    }
  });

  it('uses long Japanese sentences for the japanese shape', () => {
    const { doc } = parse(100, 'japanese');
    const titles = doc.nodes.slice(1).map(node => node.title);
    expect(titles.every(title => title.length >= 40)).toBe(true);
    expect(titles.every(title => /[ぁ-ん一-龯]/u.test(title))).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('links every node and embeds an image every IMAGE_EVERY nodes in the links shape', () => {
    const { doc, source } = parse(100, 'links');
    const items = doc.nodes.slice(1);
    expect(items.every(node => /\[\[heading-document\|参照 \d+\]\]/u.test(node.title))).toBe(true);
    const withImage = items.filter(node => attachmentMarkdown(nodeBody(doc, node)) === '![[sample-image.svg]]');
    expect(withImage).toHaveLength(Math.floor(99 / IMAGE_EVERY));
    expect(source.match(/!\[\[sample-image\.svg\]\]/gu)).toHaveLength(Math.floor(99 / IMAGE_EVERY));
  });

  it.each([500, 2000])('mixes deep chains, long titles, images and bare stages in the %i-node timeline document (E45)', count => {
    const [filename, source] = makeMixedFixture(count);
    expect(filename).toBe(`timeline-mixed-${count}.md`);
    expect(source.startsWith(`---\nmappy: true\n---\n## 大規模タイムライン（${count}ノード）\n`)).toBe(true);
    const doc = parseMarkdown(source, filename.replace(/\.md$/u, ''));
    expect(doc.nodes).toHaveLength(count);
    const top = doc.root.children[0]!;
    expect(doc.root.children).toHaveLength(1);
    const stages = top.children;
    expect(stages).toHaveLength(Math.round(count / 40));
    const bare = stages.flatMap((stage, index) => (stage.children.length === 0 ? [index] : []));
    expect(bare[0]).toBe(MIXED_FIRST_BARE_STAGE);
    expect(bare.every((index, at) => index === MIXED_FIRST_BARE_STAGE + at * MIXED_BARE_STAGE_EVERY)).toBe(true);
    expect(bare).toHaveLength(count === 500 ? 1 : 5);
    expect(Math.max(...doc.nodes.map(node => node.level)) - top.level - 1).toBe(MIXED_CHAIN_LEVELS);
    const titles = doc.nodes.map(node => node.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.filter(title => title.length >= 40).length).toBeGreaterThan(count / 10);
    const images = doc.nodes.map(node => attachmentMarkdown(nodeBody(doc, node))).filter(Boolean);
    expect(images).toContain('![[sample-image.svg]]');
    expect(images).toContain('![説明](sample-image.svg)');
    expect(images.filter(image => image === '![[存在しない画像.png|120]]')).toHaveLength(1);
    expect(attachmentMarkdown(nodeBody(doc, stages[2]!))).toBe('![[sample-image.svg|120]]');
    // E45 folds the first stage's chain at depth 8, then 4, then the stage: the first 段 8／段 4 lines of the note are in it.
    const chain = [stages[0]!];
    while (chain.at(-1)!.children.length > 0) chain.push(chain.at(-1)!.children[0]!);
    expect(chain.length - 1).toBe(MIXED_CHAIN_LEVELS);
    expect(source.match(/^ {16}- (\d+ 段 8)$/mu)?.[1]).toBe(chain[8]!.title);
    expect(source.match(/^ {8}- (\d+ 段 4)$/mu)?.[1]).toBe(chain[4]!.title);
  });

  it('rejects unknown shapes', () => {
    expect(() => makePerformanceFixture(10, 'spiral')).toThrow(/Unknown performance fixture shape/u);
  });
});
