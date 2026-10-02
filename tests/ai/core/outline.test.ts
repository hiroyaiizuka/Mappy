import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OutlineItem } from '../../../src/ai/contract';
import { claudeReader, codexReader } from '../../../src/ai/core/events';
import { neutralizeItemText, outlineResult, parseOutline } from '../../../src/ai/core/outline';
import { parseMarkdown, type MindNode } from '../../../src/core/markdown';

const texts = (items: readonly OutlineItem[]): unknown[] => items.map(item => item.children.length ? [item.text, texts(item.children)] : item.text);

function flatten(items: readonly OutlineItem[]): string[] {
  return items.flatMap(item => [item.text, ...flatten(item.children)]);
}

function nodes(node: MindNode): MindNode[] {
  return node.children.flatMap(child => [child, ...nodes(child)]);
}

/**
 * The items written the way `add-children` writes them (list items under an H2, or headings under one) and read back
 * by Mappy's parser: the same titles and the same number of nodes, which is what `add`'s validation compares.
 */
function reparsed(items: readonly OutlineItem[], form: 'list' | 'headings'): string[] {
  const lines: string[] = ['## Anchor', ''];
  const write = (list: readonly OutlineItem[], level: number): void => {
    for (const item of list) {
      if (form === 'list') lines.push(`${'  '.repeat(level)}- ${item.text}`);
      else lines.push(`${'#'.repeat(level + 3)} ${item.text}`, '');
      write(item.children, level + 1);
    }
  };
  write(items, 0);
  const doc = parseMarkdown(`${lines.join('\n')}\n`, 'note');
  const anchor = doc.root.children[0];
  if (!anchor) throw new Error('no anchor');
  return nodes(anchor).map(node => node.title);
}

describe('parseOutline', () => {
  it('reads nested list items', () => {
    const { items, dropped } = parseOutline('- A\n  - A1\n    - A1a\n- B\n', 3);
    expect(texts(items)).toEqual([['A', [['A1', ['A1a']]]], 'B']);
    expect(dropped).toBe(0);
  });

  it('strips fences and counts the other lines it drops', () => {
    const raw = 'Here is the list:\n```markdown\n- A\n- B\n```\n\nHope this helps.';
    expect(parseOutline(raw, 2)).toEqual({ items: [{ text: 'A', children: [] }, { text: 'B', children: [] }], dropped: 2 });
  });

  it('takes *, + and 1. as items, and rounds indentation by its smallest step', () => {
    expect(texts(parseOutline('* A\n    + A1\n        1. A1a\n    + A2', 3).items)).toEqual([['A', [['A1', ['A1a']], 'A2']]]);
  });

  it('never goes more than one level below the item before, and lifts what is deeper than depth', () => {
    expect(texts(parseOutline('- A\n      - deep jump\n- B\n  - B1\n    - B1a', 2).items)).toEqual([['A', ['deep jump']], ['B', ['B1', 'B1a']]]);
    expect(texts(parseOutline('- A\n  - A1', 1).items)).toEqual(['A', 'A1']);
  });

  it('counts levels from the shallowest item: a list indented as a whole stays a list of siblings', () => {
    expect(texts(parseOutline('  - A\n  - B\n    - B1\n  - C', 2).items)).toEqual(['A', ['B', ['B1']], 'C']);
  });

  it('reads a runaway answer of 300,000 items without running out of stack', () => {
    const raw = Array.from({ length: 300_000 }, (_, i) => `${i % 2 ? '  ' : ''}- item`).join('\n');
    expect(parseOutline(raw, 2).items).toHaveLength(150_000);
  });

  it('counts a tab as four columns', () => {
    expect(texts(parseOutline('- A\n\t- A1\n\t\t- A1a', 3).items)).toEqual([['A', [['A1', ['A1a']]]]]);
  });

  it('drops empty items and their place', () => {
    expect(texts(parseOutline('- A\n-\n- \n- B', 2).items)).toEqual(['A', 'B']);
  });

  it('keeps links, URLs and <br> as they are', () => {
    const raw = '- [Changelog](https://obsidian.md/changelog) and https://example.com<br>more';
    expect(flatten(parseOutline(raw, 1).items)).toEqual(['[Changelog](https://obsidian.md/changelog) and https://example.com<br>more']);
  });
});

describe('neutralizeItemText', () => {
  it.each([
    ['# heading', '\\# heading'],
    ['> quote', '\\> quote'],
    ['- nested marker', '\\- nested marker'],
    ['* nested', '\\* nested'],
    ['+ nested', '\\+ nested'],
    ['-', '\\-'],
    ['1. background', '1\\. background'],
    ['2) next', '2\\) next'],
    ['---', '\\---'],
    ['* * *', '\\* * *'],
    ['___', '\\___'],
    ['===', '\\==='],
    ['```js', '\\```js'],
    ['~~~', '\\~~~'],
    ['$$x$$', '\\$$x$$'],
    ['<div>', '\\<div>'],
    ['[03:15]: intro', '\\[03:15]: intro'],
    ['a %% comment', 'a \\%\\% comment'],
    ['a <!-- comment', 'a &lt;!-- comment'],
    ['ends with ##', 'ends with \\#\\#'],
    ['C# and F#', 'C# and F#'],
    ['plain text [03:15]', 'plain text [03:15]'],
    ['1.5 times', '1.5 times'],
    ['-5 degrees', '-5 degrees'],
  ])('%s → %s', (text, expected) => {
    expect(neutralizeItemText(text)).toBe(expected);
  });

  // Each rule, written and parsed again: one node per item, with the escaped title.
  const shapes = [
    '# heading', '> quote', '- nested marker', '* nested', '+ nested', '-', '1. background', '2) next', '---', '* * *', '___',
    '===', '```js', '~~~', '$$x$$', '<div>', '[03:15]: intro', 'a %% comment', 'a <!-- comment', 'ends with ##',
  ];
  it.each(['list', 'headings'] as const)('keeps every shape one node with the same title when written as %s and parsed again', form => {
    const raw = shapes.map(shape => `- ${shape}\n  - child of ${shape}`).join('\n');
    const { items } = parseOutline(raw, 2);
    expect(flatten(items)).toHaveLength(shapes.length * 2);
    expect(reparsed(items, form)).toEqual(flatten(items));
  });
});

describe('outlineResult', () => {
  it('is an outline with what was dropped and the raw text', () => {
    expect(outlineResult('Sure!\n- A\n- B', 2)).toEqual({
      kind: 'outline', items: [{ text: 'A', children: [] }, { text: 'B', children: [] }], dropped: 1, raw: 'Sure!\n- A\n- B',
    });
  });

  it('is a refusal for the single line the contract asks for, in either language', () => {
    expect(outlineResult('- 取得できませんでした: 字幕を読めません', 2)).toEqual({ kind: 'refused', reason: '字幕を読めません', raw: '- 取得できませんでした: 字幕を読めません' });
    expect(outlineResult('- Could not retrieve: no access', 2)).toMatchObject({ kind: 'refused', reason: 'no access' });
  });

  it('is not a refusal when the line is one item among others', () => {
    expect(outlineResult('- 取得できませんでした: 一部\n- 他の項目', 2).kind).toBe('outline');
  });

  it('is unparsable when no item is left', () => {
    expect(outlineResult('I cannot help with that.', 2)).toEqual({ kind: 'failed', reason: 'unparsable', detail: 'I cannot help with that.' });
  });

  // The final texts the CLIs gave in stage 0 and in this ticket's runs (tests/fixtures/ai, artifacts/lev-268, lev-270).
  const final = (name: string, reader: ReturnType<typeof claudeReader>): string => {
    for (const line of readFileSync(new URL(`../../fixtures/ai/${name}`, import.meta.url), 'utf8').split('\n')) reader.line(line);
    const { text } = reader.outcome();
    if (text === null) throw new Error(`${name} has no final text`);
    return text;
  };
  it.each([
    ['claude-transcript.jsonl', claudeReader, 3],
    ['claude-partial.jsonl', claudeReader, 2],
    ['claude-search-partial.jsonl', claudeReader, 2],
    ['codex-transcript.jsonl', codexReader, 3],
    ['codex-search.jsonl', codexReader, 3],
    ['codex-commands.jsonl', codexReader, 3],
  ] as const)('reads %s as an outline that survives writing and parsing again', (name, reader, depth) => {
    const result = outlineResult(final(name, reader()), depth);
    if (result.kind !== 'outline') throw new Error(`${name}: ${result.kind}`);
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.dropped).toBe(0);
    expect(reparsed(result.items, 'list')).toEqual(flatten(result.items));
    expect(reparsed(result.items, 'headings')).toEqual(flatten(result.items));
  });

  it('reads the stage-0 refusal (the CLI could not fetch the video) as refused', () => {
    expect(outlineResult(final('claude-refused.jsonl', claudeReader()), 3).kind).toBe('refused');
  });
});
