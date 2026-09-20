import { describe, expect, it } from 'vitest';
import { calledNodeId, initialCallFolds, isCalledNode, projectCalls, type CallTarget, type CallTargets } from '../../src/core/calls';
import { nodeBody } from '../../src/core/body';
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';

const MAP = ['---', 'mappy: true', '---', '## 講座', '本文の [[参考]]。', '- 回復する', '  - 睡眠', '    - 昼寝', '  - 運動', '- 記録する', '  - 日誌', '- 葉', '', '## 補足', '- 用語', ''].join('\n');
const HEADINGS = ['---', 'mappy: true', '---', '# 構成', '', '## 回復する', '### 同じ名前', '#### 深い', '## 記録する', '### 同じ名前', ''].join('\n');
const HOST = ['---', 'mappy: true', '---', '## ホスト', '- 呼び出し', '  - ![[Map]]', '    - 自分の子', '  - ![[Headings#同じ名前]]', '- ![[Map]]', '- 文中の ![[Map]]', '- ![[Missing]]', ''].join('\n');

function find(doc: MindDocument, title: string, index = 0): MindNode {
  const matches = doc.nodes.filter(node => node.title === title);
  const node = matches[index];
  if (!node) throw new Error(`no node ${title}`);
  return node;
}

function titles(node: MindNode): unknown {
  return node.children.length > 0 ? { [node.title]: node.children.map(titles) } : node.title;
}

function targetsOf(host: MindDocument, entries: [callerTitle: string, target: CallTarget, index?: number][]): CallTargets {
  return new Map(entries.map(([title, target, index]) => [find(host, title, index).id, target]));
}

describe('projectCalls', () => {
  const map = parseMarkdown(MAP, 'Map');
  const headings = parseMarkdown(HEADINGS, 'Headings');
  const host = parseMarkdown(HOST, 'Host');
  const targets = targetsOf(host, [
    ['![[Map]]', { path: 'Map.md', subpath: '', document: map }, 0],
    ['![[Headings#同じ名前]]', { path: 'Headings.md', subpath: '#同じ名前', document: headings }],
    ['![[Map]]', { path: 'Map.md', subpath: '', document: map }, 1],
  ]);
  const { root } = projectMap(host);
  const projection = projectCalls([root], targets);

  it('makes the calling item stand in for the called root: its title, then the called children, then its own children', () => {
    expect(titles(projection.roots[0] as MindNode)).toEqual({ ホスト: [
      { 呼び出し: [
        { 講座: [{ 回復する: [{ 睡眠: ['昼寝'] }, '運動'] }, { 記録する: ['日誌'] }, '葉', '自分の子'] },
        { 同じ名前: ['深い'] },
      ] },
      { 講座: [{ 回復する: [{ 睡眠: ['昼寝'] }, '運動'] }, { 記録する: ['日誌'] }, '葉'] },
      '文中の ![[Map]]',
      '![[Missing]]',
    ] });
  });

  it('keeps the host\'s own ids, ranges and kinds, so edit commands still address the host document', () => {
    const caller = find(host, '![[Map]]');
    const projected = projection.byId.get(caller.id);
    expect(projected).toMatchObject({ id: caller.id, from: caller.from, to: caller.to, titleFrom: caller.titleFrom, kind: 'list', parentId: find(host, '呼び出し').id });
    expect(projected?.title).toBe('講座');
    expect(projection.byId.get(find(host, '自分の子').id)?.parentId).toBe(caller.id);
    expect(projection.roots[0]?.title).toBe('ホスト');
    expect(projection.byId.get(projection.roots[0]?.id ?? '')).toBe(projection.roots[0]);
    // The free topic of the called note (補足) is not drawn.
    expect(Array.from(projection.byId.values()).some(node => node.title === '補足' || node.title === '用語')).toBe(false);
  });

  it('copies the called nodes under `callerId/nodeId`, re-parented and re-levelled, keeping the called document\'s ranges', () => {
    const caller = find(host, '![[Map]]');
    const recover = find(map, '回復する');
    const sleep = find(map, '睡眠');
    const projectedRecover = projection.byId.get(calledNodeId(caller.id, recover.id));
    const projectedSleep = projection.byId.get(calledNodeId(caller.id, sleep.id));
    expect(projectedRecover).toMatchObject({ id: `${caller.id}/${recover.id}`, parentId: caller.id, level: caller.level + 1, title: '回復する', from: recover.from, bodyFrom: recover.bodyFrom });
    expect(projectedSleep).toMatchObject({ parentId: projectedRecover?.id, level: caller.level + 2 });
    const source = projection.sources.get(projectedSleep?.id ?? '');
    expect(source).toMatchObject({ callerId: caller.id, path: 'Map.md', subpath: '', root: false });
    expect(source?.document).toBe(map);
    expect(source?.node).toBe(sleep);
    // A list item's body ends where its first child begins: the child is a node, not body text.
    expect(nodeBody(source?.document as MindDocument, source?.node as MindNode)).toBe('');
  });

  it('records the calling item as the root of its call, reading the called root\'s body from the called note', () => {
    const caller = find(host, '![[Map]]');
    const source = projection.sources.get(caller.id);
    expect(source).toMatchObject({ callerId: caller.id, path: 'Map.md', root: true });
    expect(source?.node).toBe(find(map, '講座'));
    expect(nodeBody(source?.document as MindDocument, source?.node as MindNode)).toBe('本文の [[参考]]。\n');
    expect(isCalledNode(projection, caller.id)).toBe(false);
    expect(isCalledNode(projection, calledNodeId(caller.id, find(map, '葉').id))).toBe(true);
    expect(isCalledNode(projection, 'root')).toBe(false);
    expect(isCalledNode(undefined, caller.id)).toBe(false);
  });

  it('draws a heading call as that section only, and the same map twice under distinct ids', () => {
    const section = find(host, '![[Headings#同じ名前]]');
    expect(projection.byId.get(section.id)?.title).toBe('同じ名前');
    expect(projection.sources.get(section.id)?.node).toBe(find(headings, '同じ名前'));
    expect(projection.byId.get(section.id)?.children.map(child => child.title)).toEqual(['深い']);
    const [first, second] = host.nodes.filter(node => node.title === '![[Map]]');
    const leaf = find(map, '葉');
    expect(projection.byId.has(calledNodeId(first?.id ?? '', leaf.id))).toBe(true);
    expect(projection.byId.has(calledNodeId(second?.id ?? '', leaf.id))).toBe(true);
    // Map twice (its body below the root: 7 nodes) plus the two calling items, the section's item and 深い.
    expect(projection.sources.size).toBe(2 * 7 + 2 + 1 + 1);
  });

  it('leaves an item alone when it has no target, its title is no longer one embed, or the heading is missing', () => {
    const missing = find(host, '![[Missing]]');
    expect(projection.byId.get(missing.id)?.title).toBe('![[Missing]]');
    expect(projection.sources.has(missing.id)).toBe(false);
    const stale = new Map<string, CallTarget>([[find(host, '文中の ![[Map]]').id, { path: 'Map.md', subpath: '', document: map }]]);
    expect(projectCalls([root], stale).sources.size).toBe(0);
    const gone = new Map<string, CallTarget>([[find(host, '![[Map]]').id, { path: 'Headings.md', subpath: '#ない見出し', document: headings }]]);
    const unresolved = projectCalls([root], gone);
    expect(unresolved.sources.size).toBe(0);
    expect(unresolved.byId.get(find(host, '![[Map]]').id)?.title).toBe('![[Map]]');
  });

  it('projects one level only: a call inside a called map is copied as its text, never grafted', () => {
    const a = parseMarkdown(['---', 'mappy: true', '---', '## A', '- ![[B]]', '- ![[A]]', ''].join('\n'), 'A');
    const b = parseMarkdown(['---', 'mappy: true', '---', '## B', '- ![[A]]', '- 葉', ''].join('\n'), 'B');
    // The reader refused the note itself; B is called, and B's own `![[A]]` is not in the targets (they are keyed by A's items).
    const fromA = projectCalls([projectMap(a).root], new Map([[find(a, '![[B]]').id, { path: 'B.md', subpath: '', document: b }]]));
    expect(titles(fromA.roots[0] as MindNode)).toEqual({ A: [{ B: ['![[A]]', '葉'] }, '![[A]]'] });
    const back = fromA.byId.get(calledNodeId(find(a, '![[B]]').id, find(b, '![[A]]').id));
    expect(back?.title).toBe('![[A]]');
    expect(back?.children).toEqual([]);
  });

  it('projects a note whose body is the virtual root and an empty section without children', () => {
    const plain = parseMarkdown('---\nmappy: true\n---\n- 一\n- 二\n', 'Plain');
    const empty = parseMarkdown('---\nmappy: true\n---\n## 空\n', 'Empty');
    const hostDoc = parseMarkdown('## H\n- ![[Plain]]\n- ![[Empty]]\n', 'H');
    const projected = projectCalls([projectMap(hostDoc).root], targetsOf(hostDoc, [
      ['![[Plain]]', { path: 'Plain.md', subpath: '', document: plain }],
      ['![[Empty]]', { path: 'Empty.md', subpath: '', document: empty }],
    ]));
    expect(titles(projected.roots[0] as MindNode)).toEqual({ H: [{ Plain: ['一', '二'] }, '空'] });
  });

  it('projects free topics of the host as well, each root in the order given', () => {
    const hostDoc = parseMarkdown('---\nmappy: true\n---\n## 本体\n- a\n## トピック\n- ![[Map]]\n', 'T');
    const { root: body, topics } = projectMap(hostDoc);
    const projected = projectCalls([body, ...topics], targetsOf(hostDoc, [['![[Map]]', { path: 'Map.md', subpath: '', document: map }]]));
    expect(projected.roots.map(titles)).toEqual([{ 本体: ['a'] }, { トピック: [{ 講座: [{ 回復する: [{ 睡眠: ['昼寝'] }, '運動'] }, { 記録する: ['日誌'] }, '葉'] }] }]);
    expect(projected.roots[1]?.id).toBe(topics[0]?.id);
  });

  it('makes a topic whose heading is one `![[map]]` stand in for the called root, the called tree its branches, its own items after (§5 M12 未選択の呼び出し)', () => {
    const hostDoc = parseMarkdown('---\nmappy: true\n---\n## 本体\n- a\n\n## ![[Map]]\n- 自分の項目\n\n## ![[Headings#同じ名前]]\n', 'T');
    const { root: body, topics } = projectMap(hostDoc);
    const [call, section] = topics;
    if (!call || !section) throw new Error('no topics');
    const projected = projectCalls([body, ...topics], targetsOf(hostDoc, [
      ['![[Map]]', { path: 'Map.md', subpath: '', document: map }],
      ['![[Headings#同じ名前]]', { path: 'Headings.md', subpath: '#同じ名前', document: headings }],
    ]));
    expect(projected.roots.map(titles)).toEqual([
      { 本体: ['a'] },
      { 講座: [{ 回復する: [{ 睡眠: ['昼寝'] }, '運動'] }, { 記録する: ['日誌'] }, '葉', '自分の項目'] },
      { 同じ名前: ['深い'] },
    ]);
    // The topic keeps its own id, range and kind (the host's heading, edited and dragged as `![[Map]]`); its source marks it the calling root.
    expect(projected.roots[1]).toMatchObject({ id: call.id, from: call.from, to: call.to, titleFrom: call.titleFrom, kind: 'atx', parentId: 'root', title: '講座' });
    expect(projected.sources.get(call.id)).toMatchObject({ callerId: call.id, path: 'Map.md', subpath: '', root: true });
    expect(isCalledNode(projected, call.id)).toBe(false);
    const grafted = projected.byId.get(calledNodeId(call.id, find(map, '回復する').id));
    expect(grafted).toMatchObject({ parentId: call.id, level: call.level + 1 });
    expect(isCalledNode(projected, grafted?.id ?? '')).toBe(true);
    expect(projected.byId.get(find(hostDoc, '自分の項目').id)?.parentId).toBe(call.id);
    expect(initialCallFolds(projected).has(grafted?.id ?? '')).toBe(true);
    // A topic that calls nothing (no target) stays as written.
    const unresolved = projectCalls([body, ...topics], new Map());
    expect(unresolved.roots.map(root => root.title)).toEqual(['本体', '![[Map]]', '![[Headings#同じ名前]]']);
    expect(unresolved.sources.size).toBe(0);
  });
});

describe('initialCallFolds', () => {
  it('folds every called node below the root that has children, never the calling item or the host\'s own nodes', () => {
    const map = parseMarkdown(MAP, 'Map');
    const host = parseMarkdown(HOST, 'Host');
    const caller = find(host, '![[Map]]');
    const projection = projectCalls([projectMap(host).root], new Map([[caller.id, { path: 'Map.md', subpath: '', document: map }]]));
    const folds = initialCallFolds(projection);
    const expected = ['回復する', '睡眠', '記録する'].map(title => calledNodeId(caller.id, find(map, title).id));
    expect(Array.from(folds).sort()).toEqual(expected.sort());
    expect(folds.has(caller.id)).toBe(false);
    expect(folds.has(find(host, '呼び出し').id)).toBe(false);
  });
});
