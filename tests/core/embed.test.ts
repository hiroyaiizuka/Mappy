import { describe, expect, it } from 'vitest';
import { transclusionsAsLinks } from '../../src/core/attachments';
import {
  embedTopicLayouts, embedTrees, findSection, initialFolds, isBlockReference, normalizeHeading, readMapFromSource, visibleNodes,
} from '../../src/core/embed';
import { parseMarkdown } from '../../src/core/markdown';
import { readTopicPositions } from '../../src/core/topics';

const HEADINGS = [
  '---', 'mappy: true', 'mappy-layout: hierarchy', '---',
  '# 講座', '', '## 回復する', '### 同じ名前', '内容 A', '#### 深い', '### 休息', '## 記録する', '### 同じ名前', '内容 B', '## 同じ名前', '',
].join('\n');

const LIST = ['---', 'mappy: true', '---', '## 本体', '- 一', '  - 一の子', '- 二', '', '## 参考資料', '- 資料', '', '## 用語', ''].join('\n');

describe('readMapFromSource', () => {
  it('claims only the YAML boolean `mappy: true` and reads the layout from the same text', () => {
    expect(readMapFromSource(HEADINGS)).toBe('hierarchy');
    expect(readMapFromSource(LIST)).toBe('mindmap');
    expect(readMapFromSource('---\nmappy: true\nmappy-layout: Timeline \n---\n')).toBe('timeline');
    expect(readMapFromSource('---\nmappy: true\nmappy-layout: unknown\n---\n')).toBe('mindmap');
    // The spellings Obsidian's own YAML reader accepts as booleans, so the text and the cache agree.
    expect(readMapFromSource('---\nmappy: True\n---\n')).toBe('mindmap');
    expect(readMapFromSource('---\nmappy: TRUE\nmappy-layout: timeline\n---\n')).toBe('timeline');
    expect(readMapFromSource('---\nmappy: False\n---\n')).toBeNull();
  });

  it('leaves the string "true", a missing key, an unfinished header and Excalidraw drawings alone', () => {
    expect(readMapFromSource('---\nmappy: "true"\n---\n')).toBeNull();
    expect(readMapFromSource('---\nmappy: false\n---\n')).toBeNull();
    expect(readMapFromSource('---\nmappy-layout: timeline\n---\n')).toBeNull();
    expect(readMapFromSource('---\nmappy: true\n')).toBeNull();
    expect(readMapFromSource('# No header\n')).toBeNull();
    expect(readMapFromSource('---\nmappy: true\nexcalidraw-plugin: parsed\n---\n')).toBeNull();
  });
});

describe('findSection', () => {
  const doc = parseMarkdown(HEADINGS, 'Note');

  it('resolves the first heading of that name in document order, like Obsidian', () => {
    const section = findSection(doc, '#同じ名前');
    expect(section?.parentId).toBe(doc.nodes.find(node => node.title === '回復する')?.id);
    expect(doc.source.slice(section?.bodyFrom, section?.to)).toContain('内容 A');
  });

  it('walks a nested path inside the earlier section and ignores case, spacing and link-breaking characters', () => {
    expect(findSection(doc, '#記録する#同じ名前')?.level).toBe(3);
    expect(doc.source.slice(findSection(doc, '#記録する#同じ名前')?.bodyFrom, findSection(doc, '#記録する#同じ名前')?.to)).toContain('内容 B');
    expect(findSection(doc, '#回復する#休息')?.title).toBe('休息');
    expect(findSection(doc, '#回復する#深い')?.title).toBe('深い');
    expect(findSection(doc, '講座')?.title).toBe('講座');
    expect(findSection(doc, '#  回復する ')?.title).toBe('回復する');
    expect(normalizeHeading('A: [[B]] | C ^d #e')).toBe('a b c d e');
    expect(findSection(parseMarkdown('## Mixed Case Heading\n', 'n'), '#mixed case  heading')?.title).toBe('Mixed Case Heading');
  });

  it('returns nothing for a missing heading, a wrong nesting, a block reference or an empty path', () => {
    expect(findSection(doc, '#存在しない')).toBeNull();
    expect(findSection(doc, '#休息#回復する')).toBeNull();
    expect(findSection(doc, '#回復する#^abc')).toBeNull();
    expect(findSection(doc, '#^abc')).toBeNull();
    expect(findSection(doc, '')).toBeNull();
    expect(findSection(doc, '#')).toBeNull();
    expect(isBlockReference('#a#^b')).toBe(true);
    expect(isBlockReference('#a#b')).toBe(false);
  });

  it('never resolves a list item as a heading in the H2 + list format', () => {
    const list = parseMarkdown(LIST, 'List');
    expect(findSection(list, '#参考資料')?.title).toBe('参考資料');
    expect(findSection(list, '#一')).toBeNull();
    expect(findSection(list, '#本体#一')).toBeNull();
  });
});

describe('embedTrees and the opening folds', () => {
  it('shows the whole map (body and free topics) for a plain embed and a single subtree for a heading', () => {
    const list = parseMarkdown(LIST, 'List');
    const whole = embedTrees(list, '');
    expect(whole?.root.title).toBe('本体');
    expect(whole?.topics.map(topic => topic.title)).toEqual(['参考資料', '用語']);
    const section = embedTrees(list, '#参考資料');
    expect(section?.root.title).toBe('参考資料');
    expect(section?.topics).toEqual([]);
    expect(embedTrees(list, '#missing')).toBeNull();
    expect(embedTrees(list, '#^block')).toBeNull();
  });

  it('folds every branch below the roots, across the body and the topics, so opening one reveals one level at a time', () => {
    const doc = parseMarkdown(HEADINGS, 'Note');
    const trees = embedTrees(doc, '');
    if (!trees) throw new Error('no trees');
    const folded = Array.from(initialFolds(trees), id => doc.nodes.find(node => node.id === id)?.title).sort();
    expect(folded).toEqual(['同じ名前', '回復する', '記録する'].sort());
    const visible = visibleNodes(trees, initialFolds(trees)).map(node => node.title);
    expect(visible).toEqual(['講座', '回復する', '記録する', '同じ名前']);
    const opened = new Set(initialFolds(trees));
    opened.delete(doc.nodes.find(node => node.title === '回復する')?.id ?? '');
    expect(visibleNodes(trees, opened).map(node => node.title)).toEqual(['講座', '回復する', '同じ名前', '休息', '記録する', '同じ名前']);
    const open = visibleNodes(trees, new Set()).map(node => node.title);
    expect(open).toEqual(['講座', '回復する', '同じ名前', '深い', '休息', '記録する', '同じ名前', '同じ名前']);
    const list = parseMarkdown(LIST, 'List');
    const listTrees = embedTrees(list, '');
    if (!listTrees) throw new Error('no trees');
    expect(Array.from(initialFolds(listTrees), id => list.nodes.find(node => node.id === id)?.title)).toEqual(['一']);
    const topics = parseMarkdown(['---', 'mappy: true', '---', '## 本体', '- a', '', '## 話題', '- b', '  - c', '    - d', ''].join('\n'), 'T');
    const topicTrees = embedTrees(topics, '');
    if (!topicTrees) throw new Error('no trees');
    expect(Array.from(initialFolds(topicTrees), id => topics.nodes.find(node => node.id === id)?.title).sort()).toEqual(['b', 'c']);
  });

  it('hands stored topic positions of the note\'s layout to the first topic of each name only', () => {
    const source = ['---', 'mappy: true', 'mappy-topics:', '  参考資料: { mindmap: [10, 20], timeline: [1, 2] }', '---',
      '## 本体', '', '## 参考資料', '', '## 参考資料', ''].join('\n');
    const doc = parseMarkdown(source, 'T');
    const trees = embedTrees(doc, '');
    if (!trees) throw new Error('no trees');
    const positions = readTopicPositions(source);
    expect(embedTopicLayouts(trees, positions, 'mindmap').map(topic => topic.position)).toEqual([{ x: 10, y: 20 }, null]);
    expect(embedTopicLayouts(trees, positions, 'hierarchy').map(topic => topic.position)).toEqual([null, null]);
  });
});

describe('transclusionsAsLinks', () => {
  it('turns note and PDF transclusions into links and keeps image embeds', () => {
    expect(transclusionsAsLinks('見出し ![[Other Map]] と ![[doc.pdf|別名]]')).toBe('見出し [[Other Map]] と [[doc.pdf|別名]]');
    expect(transclusionsAsLinks('![[図.png|120]] ![[photo.JPG#anchor]] ![[Note#見出し]]')).toBe('![[図.png|120]] ![[photo.JPG#anchor]] [[Note#見出し]]');
    expect(transclusionsAsLinks('plain')).toBe('plain');
  });

  it('leaves inline code alone, as the body rule does', () => {
    expect(transclusionsAsLinks('記法の例: `![[Note]]` と ![[Other]]')).toBe('記法の例: `![[Note]]` と [[Other]]');
    expect(transclusionsAsLinks('``a ` ![[Note]]`` ![[Note]]')).toBe('``a ` ![[Note]]`` [[Note]]');
  });
});
