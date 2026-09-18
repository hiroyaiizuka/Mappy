import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit } from '../../src/core/commands';
import { planListConversion } from '../../src/core/list-conversion';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';
import {
  MEMOS_KEY, memoPositionsFromValue, planMemoAdd, planMemoDelete, planMemoMove, planMemoText, readMemoPositions, readMemos,
  type Memo, type MemoPlan,
} from '../../src/core/memo';

const fence = (id: string, text: string, eol = '\n'): string => `\`\`\`mappy-memo ${id}${eol}${text ? text + eol : ''}\`\`\``;
const plain = '---\nmappy: true\ntags:\n  - keep\n---\n## Root\nRoot body\n\n- First\n  Body\n  - Child\n- Peer\n  Trailing prose\n';
const legacy = '---\nmappy: true\ntags:\n  - keep\n---\n# Root\nRoot body\n\n## Child\nChild body\n\n### Grandchild\nLast body\n';

function parse(source: string): MindDocument {
  return parseMarkdown(source, 'File');
}

function apply(doc: MindDocument, plan: MemoPlan): string {
  return applyEdits(doc.source, plan.edits);
}

function memo(doc: MindDocument, index = 0): Memo {
  const found = readMemos(doc)[index];
  if (!found) throw new Error('Missing memo fixture');
  return found;
}

function view(doc: MindDocument): [string, string, Record<string, { x: number; y: number }>][] {
  return readMemos(doc).map((entry) => [entry.id, entry.text, entry.positions]);
}

/** Bytes a memo operation must never touch: everything before the memo region, minus the mappy-memos key. */
function protectedBytes(source: string): string {
  const doc = parse(source);
  return source.slice(0, doc.memoRegion?.from ?? source.length).replace(/^mappy-memos:\n(?:  .*\n)*/mu, '');
}

describe('readMemos', () => {
  it('pairs each fence with its frontmatter positions in either YAML style', () => {
    const flow = `---\nmappy: true\n${MEMOS_KEY}:\n  m1: { mindmap: [120, -40], timeline: [10, 20] }\n  m2: {mindmap:[0,0]}\n---\n## Root\n\n${fence('m1', 'one')}\n\n${fence('m2', 'two\nlines')}\n`;
    expect(view(parse(flow))).toEqual([
      ['m1', 'one', { mindmap: { x: 120, y: -40 }, timeline: { x: 10, y: 20 } }], ['m2', 'two\nlines', { mindmap: { x: 0, y: 0 } }],
    ]);
    const block = `---\n${MEMOS_KEY}:\n  m1:\n    mindmap:\n      - 120\n      - -40\nmappy: true\n---\n\n${fence('m1', 'one')}\n`;
    expect(view(parse(block))).toEqual([['m1', 'one', { mindmap: { x: 120, y: -40 } }]]);
  });

  it('ignores orphaned, malformed, or non-finite positions and gives ID-less memos none', () => {
    const source = `---\n${MEMOS_KEY}:\n  gone: { mindmap: [1, 2] }\n  m1: { Mindmap: [1, 2], timeline: [1], mindmap: [x, 2], issue-tree: { x: 3, y: 4 } }\n  m2: nope\n---\n${fence('m1', 'a')}\n\n\`\`\`mappy-memo\nb\n\`\`\`\n`;
    expect(view(parse(source))).toEqual([['m1', 'a', { 'issue-tree': { x: 3, y: 4 } }], ['', 'b', {}]]);
    expect([...readMemoPositions(source).keys()]).toEqual(['gone', 'm1']);
    expect(readMemoPositions('---\nunfinished: 1\nmappy-memos:\n  m1: { mindmap: [1, 2] }').size).toBe(0);
    expect(readMemoPositions('no frontmatter').size).toBe(0);
  });

  it('accepts the object shape Obsidian\'s metadata cache would hand over', () => {
    const positions = memoPositionsFromValue({ m1: { mindmap: [1, 2], timeline: { x: 3, y: 4 }, bad: [Number.NaN, 1] }, 9: { mindmap: [1, 2] }, m2: [1, 2] });
    expect([...positions]).toEqual([['m1', { mindmap: { x: 1, y: 2 }, timeline: { x: 3, y: 4 } }]]);
    expect(memoPositionsFromValue(null).size).toBe(0);
    expect(memoPositionsFromValue([1]).size).toBe(0);
  });

  it('does not write while reading', () => {
    const source = `${plain}\n${fence('m1', 'x')}\n`;
    const doc = parse(source);
    const snapshot = JSON.stringify(doc.memoBlocks);
    readMemos(doc);
    readMemos(doc);
    expect(doc.source).toBe(source);
    expect(JSON.stringify(doc.memoBlocks)).toBe(snapshot);
  });
});

describe('planMemoAdd', () => {
  it.each([['list', plain], ['headings', legacy]])('%s: appends a placed memo and can remove it back to the identical note', (_format, note) => {
    const doc = parse(note);
    const plan = planMemoAdd(doc, '最初のメモ\n二行目', { layout: 'mindmap', position: { x: 120.4, y: -39.6 } });
    const added = apply(doc, plan);
    expect(plan.id).toBe('m1');
    expect(added).toBe(note.replace('---\n## ', `${MEMOS_KEY}:\n  m1: { mindmap: [120, -40] }\n---\n## `).replace('---\n# ', `${MEMOS_KEY}:\n  m1: { mindmap: [120, -40] }\n---\n# `)
      + `\n${fence('m1', '最初のメモ\n二行目')}\n`);
    const updated = parse(added);
    expect(view(updated)).toEqual([['m1', '最初のメモ\n二行目', { mindmap: { x: 120, y: -40 } }]]);
    expect(updated.nodes.map((node) => node.title)).toEqual(parse(note).nodes.map((node) => node.title));
    expect(protectedBytes(added)).toBe(note);
    expect(apply(updated, planMemoDelete(updated, memo(updated)))).toBe(note);
  });

  it('keeps a note without a trailing newline, an empty note, and CRLF notes in their own style', () => {
    const bare = '## Root\n- A';
    const doc = parse(bare);
    const plan = planMemoAdd(doc, 'x');
    expect(apply(doc, plan)).toBe(`${bare}\n${fence('m1', 'x')}`);
    expect(plan.edits).toHaveLength(1);
    const withMemo = parse(apply(doc, plan));
    expect(withMemo.source.slice(withMemo.root.from, withMemo.root.to)).toBe(bare);
    expect(apply(withMemo, planMemoDelete(withMemo, memo(withMemo)))).toBe(bare);

    const empty = parse('');
    const placed = planMemoAdd(empty, 'x', { layout: 'timeline', position: { x: 1, y: 2 } });
    expect(apply(empty, placed)).toBe(`---\n${MEMOS_KEY}:\n  m1: { timeline: [1, 2] }\n---\n${fence('m1', 'x')}`);
    const emptied = parse(apply(empty, placed));
    expect(apply(emptied, planMemoDelete(emptied, memo(emptied)))).toBe('---\n---\n');

    const crlf = parse('---\r\nmappy: true\r\n---\r\n## Root\r\n- A\r\n');
    const crlfPlan = planMemoAdd(crlf, 'one\ntwo\r\nthree', { layout: 'mindmap', position: { x: 0, y: 0 } });
    expect(apply(crlf, crlfPlan)).toBe(`---\r\nmappy: true\r\n${MEMOS_KEY}:\r\n  m1: { mindmap: [0, 0] }\r\n---\r\n## Root\r\n- A\r\n\r\n${fence('m1', 'one\r\ntwo\r\nthree', '\r\n')}\r\n`);
    expect(view(parse(apply(crlf, crlfPlan)))).toEqual([['m1', 'one\r\ntwo\r\nthree', { mindmap: { x: 0, y: 0 } }]]);
  });

  it('appends after existing memos, keeps the tail, and picks IDs unused by fences or positions', () => {
    const source = `---\nmappy: true\n${MEMOS_KEY}:\n  m2: { mindmap: [5, 5] }\n---\n## Root\n\n${fence('m1', 'a')}\n\n%% trailing comment %%\n`;
    const doc = parse(source);
    const plan = planMemoAdd(doc, 'b');
    expect(plan.id).toBe('m3');
    expect(apply(doc, plan)).toBe(`---\nmappy: true\n${MEMOS_KEY}:\n  m2: { mindmap: [5, 5] }\n---\n## Root\n\n${fence('m1', 'a')}\n\n${fence('m3', 'b')}\n\n%% trailing comment %%\n`);
  });

  it('closes an unfinished last fence, assigns it an ID, and chooses a longer fence for backtick lines', () => {
    const doc = parse('## Root\n\n```mappy-memo\nunfinished\n');
    const plan = planMemoAdd(doc, '```\ncode\n```');
    expect(plan.id).toBe('m2');
    expect(apply(doc, plan)).toBe('## Root\n\n```mappy-memo m1\nunfinished\n```\n\n````mappy-memo m2\n```\ncode\n```\n````');
    expect(view(parse(apply(doc, plan)))).toEqual([['m1', 'unfinished', {}], ['m2', '```\ncode\n```', {}]]);
  });

  it('refuses unfinished frontmatter, bad layouts, and non-finite positions', () => {
    expect(() => planMemoAdd(parse('---\nmappy: true\n## Root'), 'x')).toThrow('frontmatter');
    expect(() => planMemoAdd(parse(plain), 'x', { layout: 'Mind Map', position: { x: 0, y: 0 } })).toThrow('レイアウト');
    expect(() => planMemoAdd(parse(plain), 'x', { layout: 'mindmap', position: { x: Number.NaN, y: 0 } })).toThrow('位置');
  });
});

describe('planMemoText', () => {
  it('replaces only the text lines and leaves the fence, positions, and other memos alone', () => {
    const source = `---\nmappy: true\n${MEMOS_KEY}:\n  m1: { mindmap: [1, 2] }\n---\n## Root\n\n${fence('m1', 'old')}\n\n${fence('m2', 'other')}\n`;
    const doc = parse(source);
    const plan = planMemoText(doc, memo(doc), 'new\r\ntext');
    expect(plan.edits).toEqual([{ from: source.indexOf('old'), to: source.indexOf('old') + 'old\n'.length, text: 'new\ntext\n' }]);
    const updated = apply(doc, plan);
    expect(updated).toBe(source.replace('old', 'new\ntext'));
    expect(view(parse(updated))).toEqual([['m1', 'new\ntext', { mindmap: { x: 1, y: 2 } }], ['m2', 'other', {}]]);
    const cleared = apply(doc, planMemoText(doc, memo(doc), ''));
    expect(cleared).toBe(source.replace('old\n', ''));
    expect(view(parse(cleared))[0]?.[1]).toBe('');
  });

  it('rewrites the fence when the text would close it, when the fence is unfinished, or when an ID is missing', () => {
    const doc = parse(`## Root\n\n${fence('m1', 'a')}\n\n\`\`\`mappy-memo\nb\n\`\`\`\n`);
    const longer = apply(doc, planMemoText(doc, memo(doc), '```\ninner'));
    expect(longer).toBe('## Root\n\n````mappy-memo m1\n```\ninner\n````\n\n```mappy-memo\nb\n```\n');
    const named = planMemoText(doc, memo(doc, 1), 'named');
    expect(named.id).toBe('m2');
    expect(apply(doc, named)).toBe(`## Root\n\n${fence('m1', 'a')}\n\n${fence('m2', 'named')}\n`);
    const unfinished = parse('## Root\n\n```mappy-memo m1\nstill typing');
    expect(apply(unfinished, planMemoText(unfinished, memo(unfinished), 'done'))).toBe(`## Root\n\n${fence('m1', 'done')}`);
  });

  it('rejects a memo from another document state', () => {
    const doc = parse(`## Root\n\n${fence('m1', 'a')}\n`);
    const stale = memo(doc);
    const moved = parse(`## Root\n- New node\n\n${fence('m1', 'a')}\n`);
    expect(() => planMemoText(moved, stale, 'x')).toThrow('再選択');
  });
});

describe('planMemoMove', () => {
  it('changes frontmatter only, keeps other keys byte-for-byte, and stores one position per layout', () => {
    const source = `---\nmappy: true\ntags:\n  - keep\n${MEMOS_KEY}:\n  m1:\n    mindmap:\n      - 1\n      - 2\naliases: [x]\n---\n## Root\n\n${fence('m1', 'a')}\n`;
    const doc = parse(source);
    const plan = planMemoMove(doc, memo(doc), 'timeline', { x: 30.5, y: -0.4 });
    const moved = apply(doc, plan);
    expect(moved).toBe(`---\nmappy: true\ntags:\n  - keep\n${MEMOS_KEY}:\n  m1: { mindmap: [1, 2], timeline: [31, 0] }\naliases: [x]\n---\n## Root\n\n${fence('m1', 'a')}\n`);
    expect(moved.slice(parse(moved).memoRegion?.from)).toBe(source.slice(doc.memoRegion?.from));
    const again = parse(moved);
    expect(apply(again, planMemoMove(again, memo(again), 'mindmap', { x: 9, y: 9 })))
      .toContain(`  m1: { mindmap: [9, 9], timeline: [31, 0] }\n`);
    expect(planMemoMove(again, memo(again), 'timeline', { x: 31, y: 0 }).edits).toEqual([]);
  });

  it('adds the key before the closing delimiter and assigns an ID to a nameless memo', () => {
    const doc = parse('---\nmappy: true\n---\n## Root\n\n```mappy-memo\ntext\n```\n');
    const plan = planMemoMove(doc, memo(doc), 'mindmap', { x: 1, y: 2 });
    expect(plan.id).toBe('m1');
    expect(apply(doc, plan)).toBe(`---\nmappy: true\n${MEMOS_KEY}:\n  m1: { mindmap: [1, 2] }\n---\n## Root\n\n${fence('m1', 'text')}\n`);
    expect(() => planMemoMove(doc, memo(doc), 'mindmap', { x: Number.POSITIVE_INFINITY, y: 0 })).toThrow('位置');
  });
});

describe('planMemoDelete', () => {
  const three = `---\nmappy: true\n${MEMOS_KEY}:\n  m1: { mindmap: [1, 1] }\n  m3: { mindmap: [3, 3] }\nother: 1\n---\n## Root\n- A\n\n${fence('m1', 'one')}\n\n${fence('m2', 'two')}\n\n${fence('m3', 'three')}\n`;

  it.each([
    [0, `---\nmappy: true\n${MEMOS_KEY}:\n  m3: { mindmap: [3, 3] }\nother: 1\n---\n## Root\n- A\n\n${fence('m2', 'two')}\n\n${fence('m3', 'three')}\n`],
    [1, `---\nmappy: true\n${MEMOS_KEY}:\n  m1: { mindmap: [1, 1] }\n  m3: { mindmap: [3, 3] }\nother: 1\n---\n## Root\n- A\n\n${fence('m1', 'one')}\n\n${fence('m3', 'three')}\n`],
    [2, `---\nmappy: true\n${MEMOS_KEY}:\n  m1: { mindmap: [1, 1] }\nother: 1\n---\n## Root\n- A\n\n${fence('m1', 'one')}\n\n${fence('m2', 'two')}\n`],
  ])('removes memo %i with its separator and position while keeping the others', (index, expected) => {
    const doc = parse(three);
    const result = apply(doc, planMemoDelete(doc, memo(doc, index)));
    expect(result).toBe(expected);
    expect(result.slice(0, parse(result).memoRegion?.from)).toBe(expected.slice(0, expected.indexOf('\n```mappy-memo')));
  });

  it('drops the key when no positions remain and preserves a non-whitespace tail', () => {
    const source = `---\n${MEMOS_KEY}:\n  m1: { mindmap: [1, 1] }\nmappy: true\n---\n## Root\n\n${fence('m1', 'one')}\n%% keep me %%\n`;
    const doc = parse(source);
    expect(apply(doc, planMemoDelete(doc, memo(doc)))).toBe('---\nmappy: true\n---\n## Root\n%% keep me %%\n');
    const unfinished = parse('## Root\n\n```mappy-memo m1\nopen');
    expect(apply(unfinished, planMemoDelete(unfinished, memo(unfinished)))).toBe('## Root\n');
  });
});

describe('memos beside node commands', () => {
  it('survives the explicit legacy-to-list conversion unchanged', () => {
    const region = `\n${fence('m1', 'one')}\n`;
    const doc = parse(`${legacy}${region}`);
    const converted = applyEdits(doc.source, planListConversion(doc));
    const updated = parse(converted);
    expect(updated.format).toBe('list');
    expect(converted.slice(updated.memoRegion?.from)).toBe(region);
    expect(view(updated)).toEqual(view(doc));
    expect(updated.nodes.map((node) => node.title)).toEqual(['Root', 'Child', 'Grandchild']);
  });

  it('leaves the memo region untouched when nodes are added, moved, or deleted', () => {
    const region = `\n${fence('m1', 'one')}\n\n${fence('m2', 'two')}\n`;
    for (const note of [plain, legacy]) {
      const doc = parse(`${note}${region}`);
      const last = doc.nodes[doc.nodes.length - 1];
      if (!last) throw new Error('Missing fixture node');
      for (const command of [
        { type: 'add-sibling' as const, nodeId: last.id }, { type: 'add-child' as const, nodeId: last.id },
        { type: 'delete' as const, nodeId: last.id }, { type: 'move-up' as const, nodeId: last.id },
        { type: 'rename' as const, nodeId: last.id, title: 'Renamed' },
      ]) {
        const result = applyEdits(doc.source, planEdit(doc, command).edits);
        const updated = parse(result);
        expect(result.slice(updated.memoRegion?.from)).toBe(doc.source.slice(doc.memoRegion?.from));
        expect(view(updated)).toEqual(view(doc));
      }
    }
  });
});
