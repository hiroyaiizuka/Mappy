import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit, resolveDrop } from '../../src/core/commands';
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';
import {
  TOPICS_KEY, planTopicMove, planTopicMoves, planTopicPositions, planTopicRemoval, planTopicRename, readTopicPositions,
  serializeTopicPositions, topicPositionsFromValue, type TopicPositionMap,
} from '../../src/core/topics';

const fixture = readFileSync(new URL('../fixtures/free-topics.md', import.meta.url), 'utf8');
const listNote = '---\nmappy: true\n---\n- Before\n\n## Body\nBody text\n\n- A\n  - A1\n\n## Topic one\n- B\n\n## Topic two\nProse only\n';
const headingNote = '---\nmappy: true\n---\nPreamble\n\n# Body\n\n## Child\n\n# Topic one\n\n### Deep\n\n# Topic two\n';

function parse(source: string): MindDocument {
  return parseMarkdown(source, 'File');
}

function ranges(node: MindNode): number[] {
  return [node.from, node.headingTo, node.titleFrom, node.titleTo, node.bodyFrom, node.bodyTo, node.to];
}

describe('projectMap', () => {
  it('uses the first heading section as the body and later top-level sections as free topics in both formats', () => {
    const list = projectMap(parse(listNote.replace('- Before\n\n', '')));
    expect(list.root.title).toBe('Body');
    expect(list.root.children.map((node) => node.title)).toEqual(['A']);
    expect(list.topics.map((node) => [node.title, node.kind, node.parentId])).toEqual([['Topic one', 'atx', 'root'], ['Topic two', 'atx', 'root']]);
    const headings = projectMap(parse(headingNote));
    expect(headings.root.title).toBe('Body');
    expect(headings.topics.map((node) => node.title)).toEqual(['Topic one', 'Topic two']);
    expect(headings.topics[0]?.children.map((node) => node.title)).toEqual(['Deep']);
  });

  it('keeps the virtual root for documents without headings and for a single section', () => {
    const none = parse('- Only\n- Lists\n');
    expect(projectMap(none)).toEqual({ root: none.root, topics: [] });
    expect(projectMap(none).root).toBe(none.root);
    const single = parse('## Only\n- Child\n');
    expect(projectMap(single).root).toBe(single.nodes[0]);
    expect(projectMap(single).topics).toEqual([]);
    const empty = parse('');
    expect(projectMap(empty)).toEqual({ root: empty.root, topics: [] });
  });

  it('keeps a document that starts with list items on the virtual root and makes every H2 a topic', () => {
    const doc = parse(listNote);
    const { root, topics } = projectMap(doc);
    expect(root.id).toBe('root');
    expect(root.children.map((node) => node.title)).toEqual(['Before']);
    expect(topics.map((node) => node.title)).toEqual(['Body', 'Topic one', 'Topic two']);
    // The parse tree itself is untouched: commands still see every section under the virtual root.
    expect(doc.root.children.map((node) => node.title)).toEqual(['Before', 'Body', 'Topic one', 'Topic two']);
  });

  it('does not move a single byte of the body when topics follow it', () => {
    for (const note of [listNote.replace('- Before\n\n', ''), headingNote]) {
      const cut = note.indexOf('\n## Topic one\n') !== -1 ? note.indexOf('\n## Topic one\n') + 1 : note.indexOf('\n# Topic one\n') + 1;
      const withTopics = parse(note);
      const alone = parse(note.slice(0, cut));
      const body = projectMap(withTopics).root;
      const bodyAlone = projectMap(alone).root;
      expect(projectMap(alone).topics).toEqual([]);
      expect(bodyAlone.title).toBe(body.title);
      const branch = (doc: MindDocument, root: MindNode) => doc.nodes.filter((node) => node.from >= root.from && node.from < root.to);
      expect(branch(withTopics, body).map(ranges)).toEqual(branch(alone, bodyAlone).map(ranges));
      expect(withTopics.source.slice(body.from, body.to)).toBe(alone.source.slice(bodyAlone.from, bodyAlone.to));
      expect(withTopics.root.bodyFrom).toBe(alone.root.bodyFrom);
      expect(withTopics.root.bodyTo).toBe(alone.root.bodyTo);
    }
  });

  it('projects the fixture as one body and three topics with the previous multi-H2 display gone', () => {
    const doc = parseMarkdown(fixture, 'free-topics');
    const { root, topics } = projectMap(doc);
    expect(doc.format).toBe('list');
    expect(doc.root.children).toHaveLength(4);
    expect(root.title).toBe('講座の本体');
    expect(root.children.map((node) => node.title)).toEqual(['回復する', '記録する', '習慣化する']);
    expect(topics.map((node) => node.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック']);
  });
});

describe('readTopicPositions', () => {
  it('reads flow and block styles, quoted keys, and the metadata-cache object shape', () => {
    const flow = `---\nmappy: true\n${TOPICS_KEY}:\n  回復する: { mindmap: [120, -40], timeline: [10, 20] }\n  "補足: 用語": {mindmap:[0,0]}\n---\n## Root\n`;
    expect([...readTopicPositions(flow)]).toEqual([
      ['回復する', { mindmap: { x: 120, y: -40 }, timeline: { x: 10, y: 20 } }], ['補足: 用語', { mindmap: { x: 0, y: 0 } }],
    ]);
    const block = `---\n${TOPICS_KEY}:\n  回復する:\n    mindmap:\n      - 120\n      - -40\n  '補足: 用語':\n    timeline:\n      - 1\n      - 2\nmappy: true\n---\n`;
    expect([...readTopicPositions(block)]).toEqual([
      ['回復する', { mindmap: { x: 120, y: -40 } }], ['補足: 用語', { timeline: { x: 1, y: 2 } }],
    ]);
    const cached = topicPositionsFromValue({ A: { mindmap: [1, 2], timeline: { x: 3, y: 4 }, bad: [Number.NaN, 1], Mindmap: [1, 1] }, B: [1, 2], C: 'nope' });
    expect([...cached]).toEqual([['A', { mindmap: { x: 1, y: 2 }, timeline: { x: 3, y: 4 } }]]);
    expect(topicPositionsFromValue(null).size).toBe(0);
    expect(topicPositionsFromValue([1]).size).toBe(0);
  });

  it('ignores malformed entries and reads nothing from unfinished or missing frontmatter', () => {
    const source = `---\n${TOPICS_KEY}:\n  A: { timeline: [1], mindmap: [x, 2], hierarchy: { x: 3, y: 4 } }\n  B: nope\n  C: { mindmap: [1, 2, 3] }\n---\n## A\n`;
    expect([...readTopicPositions(source)]).toEqual([['A', { hierarchy: { x: 3, y: 4 } }], ['C', { mindmap: { x: 1, y: 2 } }]]);
    expect(readTopicPositions(`---\nunfinished: 1\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }`).size).toBe(0);
    expect(readTopicPositions('no frontmatter').size).toBe(0);
    expect(readTopicPositions(`---\n${TOPICS_KEY}: 5\n---\n`).size).toBe(0);
  });

  it('reads the fixture, keeping the orphan key for the reader to ignore', () => {
    const positions = readTopicPositions(fixture);
    expect([...positions.keys()]).toEqual(['参考資料', '補足: 用語', '消えた見出し']);
    expect(positions.get('参考資料')).toEqual({ mindmap: { x: -360, y: 200 }, timeline: { x: 0, y: 260 } });
  });
});

describe('serializeTopicPositions', () => {
  it('writes one flow line per topic, rounds to integers, and quotes keys YAML or the reader could misread', () => {
    const positions: TopicPositionMap = new Map([
      ['回復する', { mindmap: { x: 120.4, y: -39.6 }, timeline: { x: 10, y: 20 } }],
      ['補足: 用語', { mindmap: { x: 0, y: 0 } }],
      ['[[Note|alias]] #tag', { mindmap: { x: 1, y: 1 } }],
      ['- dash "quoted" \\ back', { mindmap: { x: 1, y: 1 } }],
      ['2024', { mindmap: { x: 1, y: 1 } }],
      ['true', { mindmap: { x: 1, y: 1 } }],
      ['', { mindmap: { x: 1, y: 1 } }],
      ['skipped', {}],
    ]);
    const text = serializeTopicPositions(positions, '\n');
    expect(text).toBe([
      `${TOPICS_KEY}:`,
      '  回復する: { mindmap: [120, -40], timeline: [10, 20] }',
      '  "補足: 用語": { mindmap: [0, 0] }',
      '  "[[Note|alias]] #tag": { mindmap: [1, 1] }',
      '  "- dash \\"quoted\\" \\\\ back": { mindmap: [1, 1] }',
      '  "2024": { mindmap: [1, 1] }',
      '  "true": { mindmap: [1, 1] }',
      '  "": { mindmap: [1, 1] }',
      '',
    ].join('\n'));
    // Round trip through the reader: every key comes back as the same heading text
    // (JavaScript objects list integer-like keys first, so compare as a set).
    const roundTrip = readTopicPositions(`---\n${text}---\n`);
    expect([...roundTrip.keys()].sort()).toEqual([...positions.keys()].filter((key) => key !== 'skipped').sort());
    expect(roundTrip.get('- dash "quoted" \\ back')).toEqual({ mindmap: { x: 1, y: 1 } });
    expect(serializeTopicPositions(new Map(), '\n')).toBe('');
    expect(serializeTopicPositions(new Map([['skipped', {}]]), '\n')).toBe('');
  });
});

describe('planTopicPositions', () => {
  const note = `---\nmappy: true\ntags:\n  - keep\n${TOPICS_KEY}:\n  A:\n    mindmap:\n      - 1\n      - 2\naliases: [x]\n---\n## Root\n\n## A\n`;

  it('replaces only the key block, keeps other keys byte-for-byte, and yields no edit for an unchanged value', () => {
    const doc = parse(note);
    const edit = planTopicMove(doc, 'A', 'timeline', { x: 30.5, y: -0.4 });
    expect(edit).not.toBeNull();
    const moved = applyEdits(doc.source, edit ? [edit] : []);
    expect(moved).toBe(`---\nmappy: true\ntags:\n  - keep\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2], timeline: [31, 0] }\naliases: [x]\n---\n## Root\n\n## A\n`);
    expect(moved.slice(moved.indexOf('---\n## Root'))).toBe(note.slice(note.indexOf('---\n## Root')));
    const again = parse(moved);
    expect(planTopicMove(again, 'A', 'timeline', { x: 31, y: 0 })).toBeNull();
    expect(planTopicPositions(again, readTopicPositions(moved))).toBeNull();
    const second = planTopicMove(again, 'B', 'mindmap', { x: 9, y: 9 });
    expect(applyEdits(moved, second ? [second] : [])).toContain(`  A: { mindmap: [1, 2], timeline: [31, 0] }\n  B: { mindmap: [9, 9] }\n`);
  });

  it('adds the key before the closing delimiter, creates a header when missing, and honours BOM and CRLF', () => {
    const existing = parse('---\nmappy: true\n---\n## Root\n\n## A\n');
    const added = planTopicMove(existing, 'A', 'mindmap', { x: 1, y: 2 });
    expect(applyEdits(existing.source, added ? [added] : [])).toBe(`---\nmappy: true\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n## Root\n\n## A\n`);
    const bare = parse('\uFEFF## Root\r\n\r\n## A\r\n');
    const created = planTopicMove(bare, 'A', 'mindmap', { x: 1, y: 2 });
    expect(applyEdits(bare.source, created ? [created] : [])).toBe(`\uFEFF---\r\n${TOPICS_KEY}:\r\n  A: { mindmap: [1, 2] }\r\n---\r\n## Root\r\n\r\n## A\r\n`);
    const parsed = parse(applyEdits(bare.source, created ? [created] : []));
    expect(parsed.nodes.map((node) => node.title)).toEqual(['Root', 'A']);
  });

  it('removes the key when no entries remain and refuses unfinished frontmatter or invalid input', () => {
    const doc = parse(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 1] }\nmappy: true\n---\n## Root\n`);
    const removed = planTopicPositions(doc, new Map());
    expect(applyEdits(doc.source, removed ? [removed] : [])).toBe('---\nmappy: true\n---\n## Root\n');
    expect(planTopicPositions(parse('## Root\n'), new Map())).toBeNull();
    expect(() => planTopicMove(parse('---\nmappy: true\n## Root'), 'A', 'mindmap', { x: 1, y: 1 })).toThrow('frontmatter');
    expect(() => planTopicMove(doc, 'A', 'Mindmap', { x: 1, y: 1 })).toThrow('レイアウト');
    expect(() => planTopicMove(doc, 'A', 'mindmap', { x: Number.POSITIVE_INFINITY, y: 1 })).toThrow('位置');
    expect(() => planTopicMove(doc, 'A\nB', 'mindmap', { x: 1, y: 1 })).toThrow('1 行');
  });

  it('keeps entries for headings that no longer exist so a Markdown-side rename can be undone by hand', () => {
    const doc = parse(`---\n${TOPICS_KEY}:\n  Gone: { mindmap: [5, 5] }\n---\n## Root\n\n## A\n`);
    const edit = planTopicMove(doc, 'A', 'mindmap', { x: 1, y: 1 });
    expect(applyEdits(doc.source, edit ? [edit] : [])).toBe(`---\n${TOPICS_KEY}:\n  Gone: { mindmap: [5, 5] }\n  A: { mindmap: [1, 1] }\n---\n## Root\n\n## A\n`);
  });
});

describe('rename keeps the topic key in step', () => {
  const note = `---\nmappy: true\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n  Other: { timeline: [3, 4] }\n---\n## Root\n- Child\n\n## A\n- Under A\n\n## Other\n`;

  function topic(doc: MindDocument, title: string): MindNode {
    const node = projectMap(doc).topics.find((candidate) => candidate.title === title);
    if (!node) throw new Error(`Missing topic ${title}`);
    return node;
  }

  it('renames the key in place within the same edit set and points the selection at the new title', () => {
    const doc = parse(note);
    const plan = planEdit(doc, { type: 'rename', nodeId: topic(doc, 'A').id, title: 'B: renamed' });
    expect(plan.edits).toHaveLength(2);
    const result = applyEdits(doc.source, plan.edits);
    expect(result).toBe(`---\nmappy: true\n${TOPICS_KEY}:\n  "B: renamed": { mindmap: [1, 2] }\n  Other: { timeline: [3, 4] }\n---\n## Root\n- Child\n\n## B: renamed\n- Under A\n\n## Other\n`);
    const renamed = parse(result);
    expect(renamed.nodes.find((node) => node.titleFrom === plan.selectionOffset)?.title).toBe('B: renamed');
    expect(readTopicPositions(result).get('B: renamed')).toEqual({ mindmap: { x: 1, y: 2 } });
  });

  it('leaves frontmatter alone for the body root, list nodes, and topics without a stored position', () => {
    const doc = parse(note);
    const body = projectMap(doc).root;
    const child = doc.nodes.find((node) => node.title === 'Child');
    const under = doc.nodes.find((node) => node.title === 'Under A');
    if (!child || !under) throw new Error('Missing fixture nodes');
    for (const node of [body, child, under]) {
      const plan = planEdit(doc, { type: 'rename', nodeId: node.id, title: 'A' });
      expect(plan.edits).toHaveLength(1);
      expect(applyEdits(doc.source, plan.edits).slice(0, doc.source.indexOf('## Root'))).toBe(doc.source.slice(0, doc.source.indexOf('## Root')));
    }
    const unplaced = parse(note.replace('  A: { mindmap: [1, 2] }\n', ''));
    expect(planEdit(unplaced, { type: 'rename', nodeId: topic(unplaced, 'A').id, title: 'B' }).edits).toHaveLength(1);
    expect(planEdit(doc, { type: 'rename', nodeId: topic(doc, 'A').id, title: 'A' }).edits).toHaveLength(1);
  });

  it('leaves the entry alone when a node that merely shares a topic\'s text is renamed', () => {
    const doc = parse(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n## Root\n- A\n\n## A\n- Under A\n`);
    const item = doc.nodes.find((node) => node.title === 'A' && node.kind === 'list');
    if (!item) throw new Error('Missing item');
    const plan = planEdit(doc, { type: 'rename', nodeId: item.id, title: 'B' });
    expect(plan.edits).toHaveLength(1);
    expect(applyEdits(doc.source, plan.edits)).toBe(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n## Root\n- B\n\n## A\n- Under A\n`);
    const placed = planEdit(doc, { type: 'rename', nodeId: item.id, title: 'B', position: { layout: 'mindmap', x: 5, y: 5 } });
    expect(placed.edits).toHaveLength(1);
  });

  it('never takes the position of another current topic, but replaces an orphan entry under the new name', () => {
    const doc = parse(note);
    const collided = applyEdits(doc.source, planEdit(doc, { type: 'rename', nodeId: topic(doc, 'A').id, title: 'Other' }).edits);
    expect(readTopicPositions(collided).get('Other')).toEqual({ timeline: { x: 3, y: 4 } });
    expect(readTopicPositions(collided).has('A')).toBe(false);
    const orphaned = parse(note.replace('## Other\n', ''));
    const reused = applyEdits(orphaned.source, planEdit(orphaned, { type: 'rename', nodeId: topic(orphaned, 'A').id, title: 'Other' }).edits);
    expect([...readTopicPositions(reused)]).toEqual([['Other', { mindmap: { x: 1, y: 2 } }]]);
    expect(planTopicRename(doc, 'Missing', 'X')).toBeNull();
  });

  it('creates the header edit first when the note has no frontmatter yet and the topic is positioned by the caller', () => {
    const bare = parse('## Root\n\n## A\n');
    const placed = planTopicMove(bare, 'A', 'mindmap', { x: 1, y: 1 });
    const doc = parse(applyEdits(bare.source, placed ? [placed] : []));
    const plan = planEdit(doc, { type: 'rename', nodeId: topic(doc, 'A').id, title: 'B' });
    expect(applyEdits(doc.source, plan.edits)).toBe(`---\n${TOPICS_KEY}:\n  B: { mindmap: [1, 1] }\n---\n## Root\n\n## B\n`);
  });
});

describe('add-topic appends an empty top-level section at the end of the document', () => {
  it('adds `## ` after the last section of a list document and selects its empty title', () => {
    const doc = parse(listNote);
    const plan = planEdit(doc, { type: 'add-topic' });
    const result = applyEdits(doc.source, plan.edits);
    expect(result).toBe(`${listNote}\n## \n`);
    const parsed = parse(result);
    const added = parsed.nodes.find((node) => node.titleFrom === plan.selectionOffset);
    expect(added).toMatchObject({ title: '', kind: 'atx', level: 2, parentId: 'root' });
    expect(projectMap(parsed).topics.at(-1)).toBe(added);
    expect(result.slice(0, listNote.length)).toBe(listNote);
  });

  it('keeps the ending convention: a file without a trailing newline stays without one, a blank line is not doubled', () => {
    const trimmed = parse('## Body\n- A\n\n## T\n- B');
    expect(applyEdits(trimmed.source, planEdit(trimmed, { type: 'add-topic' }).edits)).toBe('## Body\n- A\n\n## T\n- B\n\n## ');
    const blank = parse('## Body\n- A\n\n');
    expect(applyEdits(blank.source, planEdit(blank, { type: 'add-topic' }).edits)).toBe('## Body\n- A\n\n## \n');
    const crlf = parse('## Body\r\n- A\r\n');
    expect(applyEdits(crlf.source, planEdit(crlf, { type: 'add-topic' }).edits)).toBe('## Body\r\n- A\r\n\r\n## \r\n');
  });

  it('matches the depth of the last top-level section in a heading document', () => {
    const doc = parse(headingNote);
    expect(applyEdits(doc.source, planEdit(doc, { type: 'add-topic' }).edits)).toBe(`${headingNote}\n# \n`);
    const h2 = parse('## A\n\n### A1\n\n## B\n');
    expect(h2.format).toBe('headings');
    const result = applyEdits(h2.source, planEdit(h2, { type: 'add-topic' }).edits);
    expect(result).toBe('## A\n\n### A1\n\n## B\n\n## \n');
    expect(projectMap(parse(result)).topics.map((node) => node.title)).toEqual(['B', '']);
  });

  it('starts the body for a document without headings and lands after trailing prose', () => {
    const empty = parse('');
    expect(applyEdits(empty.source, planEdit(empty, { type: 'add-topic' }).edits)).toBe('## ');
    const header = parse('---\nmappy: true\n---\n');
    const started = applyEdits(header.source, planEdit(header, { type: 'add-topic' }).edits);
    expect(started).toBe('---\nmappy: true\n---\n\n## \n');
    expect(projectMap(parse(started)).topics).toEqual([]);
    const lists = parse('- A\n- B\n\nProse after the list.\n');
    const result = applyEdits(lists.source, planEdit(lists, { type: 'add-topic' }).edits);
    expect(result).toBe('- A\n- B\n\nProse after the list.\n\n## \n');
    expect(projectMap(parse(result)).topics.map((node) => node.title)).toEqual(['']);
  });

  it('refuses when the end of the document cannot hold a heading', () => {
    const fence = parse('## Body\n\n```\ncode');
    expect(() => planEdit(fence, { type: 'add-topic' })).toThrow('トピックを追加できません');
  });
});

describe('rename with a position places a new topic in the same edit set', () => {
  const note = `---\nmappy: true\n---\n## Root\n- Child\n\n## \n`;

  it('writes the title and the position of the pressed point as two non-overlapping edits', () => {
    const doc = parse(note);
    const blank = projectMap(doc).topics[0];
    if (!blank) throw new Error('Missing blank topic');
    expect(blank.title).toBe('');
    const plan = planEdit(doc, { type: 'rename', nodeId: blank.id, title: '新しい話題', position: { layout: 'mindmap', x: 320.6, y: -80.2 } });
    expect(plan.edits).toHaveLength(2);
    const result = applyEdits(doc.source, plan.edits);
    expect(result).toBe(`---\nmappy: true\n${TOPICS_KEY}:\n  新しい話題: { mindmap: [321, -80] }\n---\n## Root\n- Child\n\n## 新しい話題\n`);
    const parsed = parse(result);
    expect(parsed.nodes.find((node) => node.titleFrom === plan.selectionOffset)?.title).toBe('新しい話題');
    expect(readTopicPositions(result).get('新しい話題')).toEqual({ mindmap: { x: 321, y: -80 } });
  });

  it('keeps the other layout of a topic that already has a position and adds the placed one', () => {
    const doc = parse(note.replace('---\n## Root', `${TOPICS_KEY}:\n  "": { timeline: [5, 6] }\n---\n## Root`));
    const blank = projectMap(doc).topics[0];
    if (!blank) throw new Error('Missing blank topic');
    const result = applyEdits(doc.source, planEdit(doc, { type: 'rename', nodeId: blank.id, title: 'Named', position: { layout: 'mindmap', x: 1, y: 2 } }).edits);
    expect(readTopicPositions(result).get('Named')).toEqual({ timeline: { x: 5, y: 6 }, mindmap: { x: 1, y: 2 } });
    expect(readTopicPositions(result).has('')).toBe(false);
  });

  it('does not take the entry of another current topic with the new name, and ignores the position for non-topics', () => {
    const doc = parse(`---\n${TOPICS_KEY}:\n  Other: { mindmap: [3, 4] }\n---\n## Root\n- Child\n\n## Other\n\n## \n`);
    const blank = projectMap(doc).topics[1];
    if (!blank) throw new Error('Missing blank topic');
    const result = applyEdits(doc.source, planEdit(doc, { type: 'rename', nodeId: blank.id, title: 'Other', position: { layout: 'mindmap', x: 9, y: 9 } }).edits);
    expect([...readTopicPositions(result)]).toEqual([['Other', { mindmap: { x: 3, y: 4 } }]]);
    const child = doc.nodes.find((node) => node.title === 'Child');
    const body = projectMap(doc).root;
    for (const node of [child, body]) {
      if (!node) throw new Error('Missing node');
      const plan = planEdit(doc, { type: 'rename', nodeId: node.id, title: 'Renamed', position: { layout: 'mindmap', x: 9, y: 9 } });
      expect(plan.edits).toHaveLength(1);
    }
    expect(() => planEdit(doc, { type: 'rename', nodeId: blank.id, title: 'X', position: { layout: 'Bad Layout', x: 0, y: 0 } })).toThrow('レイアウト名');
    expect(() => planEdit(doc, { type: 'rename', nodeId: blank.id, title: 'X', position: { layout: 'mindmap', x: Number.NaN, y: 0 } })).toThrow('位置が不正');
  });
});

describe('delete removes a topic section together with its position', () => {
  const note = `---\nmappy: true\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n  Other: { timeline: [3, 4] }\n  Gone: { mindmap: [7, 7] }\n---\n## Root\n- Child\n\n## A\n- Under A\n  - Deep\n\n## Other\n`;

  function topic(doc: MindDocument, title: string): MindNode {
    const node = projectMap(doc).topics.find((candidate) => candidate.title === title);
    if (!node) throw new Error(`Missing topic ${title}`);
    return node;
  }

  it('drops only the deleted heading\'s entry, keeps the others and the orphan, and leaves the body untouched', () => {
    const doc = parse(note);
    const plan = planEdit(doc, { type: 'delete', nodeId: topic(doc, 'A').id });
    expect(plan.edits).toHaveLength(2);
    const result = applyEdits(doc.source, plan.edits);
    expect(result).toBe(`---\nmappy: true\n${TOPICS_KEY}:\n  Other: { timeline: [3, 4] }\n  Gone: { mindmap: [7, 7] }\n---\n## Root\n- Child\n\n## Other\n`);
    expect(parse(result).nodes.map((node) => node.title)).toEqual(['Root', 'Child', 'Other']);
  });

  it('removes the whole key when the last positioned topic goes, in both formats', () => {
    const list = parse(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n## Root\n- Child\n\n## A\n- Under A\n`);
    const listResult = applyEdits(list.source, planEdit(list, { type: 'delete', nodeId: topic(list, 'A').id }).edits);
    expect(listResult).toBe('## Root\n- Child\n');
    const headings = parse(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n# Root\n\n## Child\n\n# A\n\n### Deep\n`);
    const headingResult = applyEdits(headings.source, planEdit(headings, { type: 'delete', nodeId: topic(headings, 'A').id }).edits);
    expect(headingResult).toBe('# Root\n\n## Child\n');
    // The header held nothing else, so it goes as a whole rather than leaving an empty `---` pair.
    expect(planTopicRemoval(headings, topic(headings, 'A'))).toEqual({ from: 0, to: `---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n`.length, text: '' });
  });

  it('takes the separating blank lines of a section at the end of the file, so add-topic then delete round-trips', () => {
    for (const source of [listNote, headingNote, '## Body\n- A\n\n## T\n- B', '## Body\r\n- A\r\n']) {
      const doc = parse(source);
      const added = parse(applyEdits(doc.source, planEdit(doc, { type: 'add-topic' }).edits));
      const blank = projectMap(added).topics.at(-1);
      if (!blank) throw new Error('Missing added topic');
      expect(applyEdits(added.source, planEdit(added, { type: 'delete', nodeId: blank.id }).edits)).toBe(source);
    }
    const middle = parse('## Root\n- Child\n\n## A\n- Under A\n\n## Other\n');
    expect(applyEdits(middle.source, planEdit(middle, { type: 'delete', nodeId: topic(middle, 'A').id }).edits)).toBe('## Root\n- Child\n\n## Other\n');
  });

  it('keeps the entry while another current topic shares the heading, and for nodes that are not topics', () => {
    const doc = parse(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n## Root\n- Child\n\n## A\n- First\n\n## A\n- Second\n`);
    const [first, second] = projectMap(doc).topics;
    if (!first || !second) throw new Error('Missing topics');
    const result = applyEdits(doc.source, planEdit(doc, { type: 'delete', nodeId: second.id }).edits);
    expect(result).toBe(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 2] }\n---\n## Root\n- Child\n\n## A\n- First\n`);
    expect(planTopicRemoval(doc, first)).toBeNull();
    const child = doc.nodes.find((node) => node.title === 'Child');
    if (!child) throw new Error('Missing child');
    expect(planEdit(doc, { type: 'delete', nodeId: child.id }).edits).toHaveLength(1);
    expect(planTopicRemoval(doc, child)).toBeNull();
    expect(planTopicRemoval(doc, projectMap(doc).root)).toBeNull();
  });
});

describe('a topic dropped on a node joins it as a branch (合流)', () => {
  function topic(doc: MindDocument, title: string): MindNode {
    const node = projectMap(doc).topics.find((candidate) => candidate.title === title);
    if (!node) throw new Error(`Missing topic ${title}`);
    return node;
  }
  function node(doc: MindDocument, title: string): MindNode {
    const found = doc.nodes.find((candidate) => candidate.title === title);
    if (!found) throw new Error(`Missing node ${title}`);
    return found;
  }

  it('turns the section into a list item under the target, keeping prose, images and nested lists, and drops its entry', () => {
    const doc = parse(fixture);
    const reference = topic(doc, '参考資料');
    const recover = node(doc, '回復する');
    const plan = planEdit(doc, { type: 'move', nodeId: reference.id, parentId: recover.id, index: recover.children.length });
    const result = applyEdits(doc.source, plan.edits);
    expect(result).toBe(fixture
      .replace('  参考資料: { mindmap: [-360, 200], timeline: [0, 260] }\n', '')
      .replace('  - 睡眠\n', '  - 睡眠\n  - 参考資料\n    位置は frontmatter の `mappy-topics` にあり、本文には何も書かない。\n\n    - [[heading-document|講座ノート]]\n    - ![[sample-image.svg]]\n    - [外部の資料](https://example.com)\n')
      .replace('\n## 参考資料\n\n位置は frontmatter の `mappy-topics` にあり、本文には何も書かない。\n\n- [[heading-document|講座ノート]]\n- ![[sample-image.svg]]\n- [外部の資料](https://example.com)\n\n', '\n'));
    const parsed = parse(result);
    expect(projectMap(parsed).topics.map((item) => item.title)).toEqual(['補足: 用語', '位置のないトピック']);
    const joined = parsed.nodes.find((item) => item.titleFrom === plan.selectionOffset);
    expect(joined).toMatchObject({ title: '参考資料', kind: 'list', level: 4 });
    expect(joined?.children.map((item) => item.title)).toEqual(['[[heading-document|講座ノート]]', '![[sample-image.svg]]', '[外部の資料](https://example.com)']);
    expect(parsed.nodes.length).toBe(doc.nodes.length);
    expect(readTopicPositions(result).has('参考資料')).toBe(false);
    expect(readTopicPositions(result).get('補足: 用語')).toEqual({ mindmap: { x: 560, y: -140 } });
  });

  it('places the item as a sibling before or after the target, matching the neighbours\' indent and marker', () => {
    const doc = parse('## Body\n* a\n  * a1\n* b\n\n## T\nprose\n\n- t1\n  - t2\n\n## U\n');
    const t = topic(doc, 'T');
    const before = applyEdits(doc.source, planEdit(doc, { type: 'move', nodeId: t.id, parentId: node(doc, 'a').id, index: 0 }).edits);
    expect(before).toBe('## Body\n* a\n  * T\n    prose\n\n    - t1\n      - t2\n  * a1\n* b\n\n## U\n');
    const after = applyEdits(doc.source, planEdit(doc, { type: 'move', nodeId: t.id, parentId: projectMap(doc).root.id, index: 2 }).edits);
    expect(after).toBe('## Body\n* a\n  * a1\n* b\n* T\n  prose\n\n  - t1\n    - t2\n\n## U\n');
    expect(parse(after).nodes.map((item) => `${item.level}:${item.title}`)).toEqual(['2:Body', '3:a', '4:a1', '3:b', '3:T', '4:t1', '5:t2', '2:U']);
  });

  it('handles a topic without children, the last section of the file, CRLF, and a code fence in the body', () => {
    const last = parse('## Body\n- a\n\n## T\n');
    expect(applyEdits(last.source, planEdit(last, { type: 'move', nodeId: topic(last, 'T').id, parentId: node(last, 'a').id, index: 0 }).edits))
      .toBe('## Body\n- a\n  - T\n');
    const crlf = parse('## Body\r\n- a\r\n\r\n## T\r\n\r\n- t1\r\n');
    expect(applyEdits(crlf.source, planEdit(crlf, { type: 'move', nodeId: topic(crlf, 'T').id, parentId: projectMap(crlf).root.id, index: 1 }).edits))
      .toBe('## Body\r\n- a\r\n- T\r\n  - t1\r\n');
    const fence = parse('## Body\n- a\n\n## T\n\n```js\n- not a node\n```\n\n- t1\n\n## U\n- u\n');
    const result = applyEdits(fence.source, planEdit(fence, { type: 'move', nodeId: topic(fence, 'T').id, parentId: node(fence, 'a').id, index: 0 }).edits);
    expect(result).toBe('## Body\n- a\n  - T\n    ```js\n    - not a node\n    ```\n\n    - t1\n\n## U\n- u\n');
    expect(parse(result).nodes.map((item) => item.title)).toEqual(['Body', 'a', 'T', 't1', 'U', 'u']);
  });

  it('moves a topic section under a heading in heading documents through the existing section move and drops its entry too', () => {
    const doc = parse(`---\n${TOPICS_KEY}:\n  Topic: { mindmap: [1, 2] }\n---\n# Body\n\n## Child\n\n# Topic\n\n### Deep\n`);
    const result = applyEdits(doc.source, planEdit(doc, { type: 'move', nodeId: topic(doc, 'Topic').id, parentId: node(doc, 'Child').id, index: 0 }).edits);
    expect(result).toBe('# Body\n\n## Child\n\n### Topic\n\n##### Deep\n');
  });

  it('planTopicMoves stores several headings at once and refuses bad input', () => {
    const doc = parse(fixture);
    const edit = planTopicMoves(doc, 'mindmap', new Map([['参考資料', { x: -460, y: 150 }], ['位置のないトピック', { x: -100, y: 300 }]]));
    const result = applyEdits(doc.source, edit ? [edit] : []);
    expect(readTopicPositions(result).get('参考資料')).toEqual({ mindmap: { x: -460, y: 150 }, timeline: { x: 0, y: 260 } });
    expect(readTopicPositions(result).get('位置のないトピック')).toEqual({ mindmap: { x: -100, y: 300 } });
    expect(readTopicPositions(result).get('補足: 用語')).toEqual({ mindmap: { x: 560, y: -140 } });
    expect(result.slice(result.indexOf('---\n', 4))).toBe(fixture.slice(fixture.indexOf('---\n', 4)));
    expect(planTopicMoves(doc, 'mindmap', new Map([['参考資料', { x: -360, y: 200 }]]))).toBeNull();
    expect(() => planTopicMoves(doc, 'Bad', new Map())).toThrow('レイアウト名');
    expect(() => planTopicMoves(doc, 'mindmap', new Map([['参考資料', { x: Number.NaN, y: 0 }]]))).toThrow('位置が不正');
  });
});

describe('a branch dropped on empty canvas detaches into a new topic (切り離し)', () => {
  function node(doc: MindDocument, title: string): MindNode {
    const found = doc.nodes.find((candidate) => candidate.title === title);
    if (!found) throw new Error(`Missing node ${title}`);
    return found;
  }

  it('turns the branch into an H2 section at the end, dedented, with its drop point stored in the same edit set', () => {
    const doc = parse(fixture);
    const recover = node(doc, '回復する');
    const plan = planEdit(doc, { type: 'detach', nodeId: recover.id, position: { layout: 'mindmap', x: 300, y: 420 } });
    expect(plan.edits).toHaveLength(3);
    const result = applyEdits(doc.source, plan.edits);
    expect(result).toBe(fixture
      .replace('  消えた見出し: { mindmap: [0, 0] }\n', '  消えた見出し: { mindmap: [0, 0] }\n  回復する: { mindmap: [300, 420] }\n')
      .replace('- 回復する\n  参考: [[heading-document#回復する|回復]]\n  - 休息の取り方\n  - 睡眠\n', '')
      + '\n## 回復する\n\n参考: [[heading-document#回復する|回復]]\n- 休息の取り方\n- 睡眠\n');
    const parsed = parse(result);
    const detached = parsed.nodes.find((item) => item.titleFrom === plan.selectionOffset);
    expect(detached).toMatchObject({ title: '回復する', kind: 'atx', level: 2, parentId: 'root' });
    expect(detached?.children.map((item) => item.title)).toEqual(['休息の取り方', '睡眠']);
    expect(projectMap(parsed).topics.map((item) => item.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック', '回復する']);
    expect(projectMap(parsed).root.children.map((item) => item.title)).toEqual(['記録する', '習慣化する']);
    expect(parsed.nodes.length).toBe(doc.nodes.length);
    expect(readTopicPositions(result).get('回復する')).toEqual({ mindmap: { x: 300, y: 420 } });
  });

  it('detaches a deep branch, a branch inside a topic, a top-level item of a virtual root, and the last item of the file', () => {
    const deep = parse('## Body\n- a\n  - b\n    text under b\n    - c\n  - d\n');
    expect(applyEdits(deep.source, planEdit(deep, { type: 'detach', nodeId: node(deep, 'b').id }).edits))
      .toBe('## Body\n- a\n  - d\n\n## b\n\ntext under b\n- c\n');
    const inTopic = parse('## Body\n- a\n\n## T\n- t1\n  - t2\n- t3\n');
    expect(applyEdits(inTopic.source, planEdit(inTopic, { type: 'detach', nodeId: node(inTopic, 't1').id }).edits))
      .toBe('## Body\n- a\n\n## T\n- t3\n\n## t1\n\n- t2\n');
    const virtual = parse('- first\n  - child\n- second\n\n## T\n- t\n');
    const detachedVirtual = applyEdits(virtual.source, planEdit(virtual, { type: 'detach', nodeId: node(virtual, 'first').id }).edits);
    expect(detachedVirtual).toBe('- second\n\n## T\n- t\n\n## first\n\n- child\n');
    expect(projectMap(parse(detachedVirtual)).topics.map((item) => item.title)).toEqual(['T', 'first']);
    const last = parse('## Body\n- a\n- b\n  - b1');
    expect(applyEdits(last.source, planEdit(last, { type: 'detach', nodeId: node(last, 'b').id }).edits)).toBe('## Body\n- a\n\n## b\n\n- b1');
    const crlf = parse('## Body\r\n- a\r\n  - a1\r\n- b\r\n');
    expect(applyEdits(crlf.source, planEdit(crlf, { type: 'detach', nodeId: node(crlf, 'a').id }).edits)).toBe('## Body\r\n- b\r\n\r\n## a\r\n\r\n- a1\r\n');
  });

  it('keeps a code fence and tabs in the body, and refuses the body root and the virtual root', () => {
    const fence = parse('## Body\n- a\n  ```js\n  - not a node\n  ```\n  - a1\n- b\n');
    const result = applyEdits(fence.source, planEdit(fence, { type: 'detach', nodeId: node(fence, 'a').id }).edits);
    expect(result).toBe('## Body\n- b\n\n## a\n\n```js\n- not a node\n```\n- a1\n');
    expect(parse(result).nodes.map((item) => item.title)).toEqual(['Body', 'b', 'a', 'a1']);
    const tabs = parse('## Body\n- a\n\tnote\n\t- a1\n');
    expect(applyEdits(tabs.source, planEdit(tabs, { type: 'detach', nodeId: node(tabs, 'a').id }).edits)).toBe('## Body\n\n## a\n\nnote\n- a1\n');
    const doc = parse(fixture);
    expect(() => planEdit(doc, { type: 'detach', nodeId: projectMap(doc).root.id })).toThrow();
    expect(() => planEdit(doc, { type: 'detach', nodeId: 'root' })).toThrow();
  });

  it('does not store a position when another current topic already has the heading, and detaches heading branches by moving them to the top level', () => {
    const doc = parse('---\nmappy-topics:\n  a: { mindmap: [1, 1] }\n---\n## Body\n- a\n  - x\n\n## a\n- y\n');
    const result = applyEdits(doc.source, planEdit(doc, { type: 'detach', nodeId: node(doc, 'a').id, position: { layout: 'mindmap', x: 9, y: 9 } }).edits);
    expect(result).toBe('---\nmappy-topics:\n  a: { mindmap: [1, 1] }\n---\n## Body\n\n## a\n- y\n\n## a\n\n- x\n');
    const headings = parse('# Body\n\n## Child\n\n### Deep\n\n## Other\n');
    const plan = planEdit(headings, { type: 'detach', nodeId: node(headings, 'Child').id, position: { layout: 'mindmap', x: 5, y: 6 } });
    const moved = applyEdits(headings.source, plan.edits);
    expect(moved).toBe('---\nmappy-topics:\n  Child: { mindmap: [5, 6] }\n---\n# Body\n\n## Other\n\n# Child\n\n## Deep\n');
    expect(parse(moved).nodes.find((item) => item.titleFrom === plan.selectionOffset)?.title).toBe('Child');
  });
});

describe('review follow-ups: body guard, header birth at the top of the note, fence whitespace', () => {
  function node(doc: MindDocument, title: string): MindNode {
    const found = doc.nodes.find((candidate) => candidate.title === title);
    if (!found) throw new Error(`Missing node ${title}`);
    return found;
  }

  it('never lets the body root join a node, in heading documents too, while ordinary heading branches still move', () => {
    const headings = parse('# Body\n\n## Child\n\n# T\n\n## Under T\n');
    const body = projectMap(headings).root;
    expect(resolveDrop(headings, body.id, node(headings, 'T').id, 'inside')).toBeNull();
    expect(resolveDrop(headings, body.id, node(headings, 'Under T').id, 'after')).toBeNull();
    expect(resolveDrop(headings, node(headings, 'Child').id, node(headings, 'Under T').id, 'after'))
      .toEqual({ type: 'move', nodeId: node(headings, 'Child').id, parentId: node(headings, 'T').id, index: 1 });
    expect(resolveDrop(headings, node(headings, 'T').id, node(headings, 'Child').id, 'inside'))
      .toEqual({ type: 'move', nodeId: node(headings, 'T').id, parentId: node(headings, 'Child').id, index: 0 });
    const list = parse('## Body\n- a\n\n## T\n- t\n');
    expect(resolveDrop(list, projectMap(list).root.id, node(list, 't').id, 'inside')).toBeNull();
  });

  it('detaching the first line of a note without a header creates the header in the same edit as the removal', () => {
    const doc = parse('- a\n  - b\n- c\n\n## T\n- t\n');
    const plan = planEdit(doc, { type: 'detach', nodeId: node(doc, 'a').id, position: { layout: 'mindmap', x: 3, y: 4 } });
    const result = applyEdits(doc.source, plan.edits);
    expect(result).toBe(`---\n${TOPICS_KEY}:\n  a: { mindmap: [3, 4] }\n---\n- c\n\n## T\n- t\n\n## a\n\n- b\n`);
    expect(parse(result).nodes.find((item) => item.titleFrom === plan.selectionOffset)?.title).toBe('a');
  });

  it('keeps whitespace-only lines inside fences byte for byte through join and detach', () => {
    const list = parse('## Body\n- a\n\n## T\n\n```\nx\n  \ny\n```\n');
    const joined = applyEdits(list.source, planEdit(list, { type: 'move', nodeId: node(list, 'T').id, parentId: node(list, 'a').id, index: 0 }).edits);
    expect(joined).toBe('## Body\n- a\n  - T\n    ```\n    x\n      \n    y\n    ```\n');
    const back = parse(joined);
    const detached = applyEdits(back.source, planEdit(back, { type: 'detach', nodeId: node(back, 'T').id }).edits);
    expect(detached).toBe('## Body\n- a\n\n## T\n\n```\nx\n  \ny\n```\n');
  });

  it('removes an emptied header entirely but keeps one that holds other keys', () => {
    const only = parse(`---\n${TOPICS_KEY}:\n  A: { mindmap: [1, 1] }\n---\n## Root\n\n## A\n`);
    expect(applyEdits(only.source, planEdit(only, { type: 'delete', nodeId: projectMap(only).topics[0]?.id ?? '' }).edits)).toBe('## Root\n');
    const withKey = parse(`---\nmappy: true\n${TOPICS_KEY}:\n  A: { mindmap: [1, 1] }\n---\n## Root\n\n## A\n`);
    expect(applyEdits(withKey.source, planEdit(withKey, { type: 'delete', nodeId: projectMap(withKey).topics[0]?.id ?? '' }).edits)).toBe('---\nmappy: true\n---\n## Root\n');
  });
});
