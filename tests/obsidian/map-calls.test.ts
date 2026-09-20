// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { HarnessApp } from '../../harness/browser/app';
import { parseMarkdown } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import { CallReader, sameTargets } from '../../src/obsidian/map-calls';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

const MAP = '---\nmappy: true\n---\n## 講座\n- 回復する\n- 記録する\n';
const HOST = '---\nmappy: true\n---\n## ホスト\n- ![[Map]]\n- ![[Map#回復する]]\n- ![[Host]]\n- ![[Plain]]\n- ![[Missing]]\n- ![[Map#^block]]\n- 文中の ![[Map]]\n- ![[Map]]\n';

function setup(notes: Record<string, string>) {
  const app = new HarnessApp();
  for (const [path, content] of Object.entries(notes)) app.put(path, content);
  const store = new DocumentStore(app.asApp<App>());
  return { app, reader: new CallReader(app.asApp<App>(), store) };
}

describe('CallReader', () => {
  it('resolves every `![[…]]`-only item to a map note, refusing the host itself, plain notes, missing notes and block references', async () => {
    const { reader } = setup({ 'Host.md': HOST, 'Map.md': MAP, 'Plain.md': '## Plain\n- a\n' });
    const host = parseMarkdown(HOST, 'Host');
    const targets = await reader.read(host, 'Host.md');
    const byTitle = new Map(host.nodes.map(node => [node.title, targets.get(node.id)]));
    expect(byTitle.get('![[Map]]')).toMatchObject({ path: 'Map.md', subpath: '' });
    expect(byTitle.get('![[Map#回復する]]')).toMatchObject({ path: 'Map.md', subpath: '#回復する' });
    for (const title of ['![[Host]]', '![[Plain]]', '![[Missing]]', '![[Map#^block]]', '文中の ![[Map]]']) expect(byTitle.get(title)).toBeUndefined();
    expect(targets.size).toBe(3);
    // The same note is parsed once, whatever the number of items calling it.
    const documents = new Set(Array.from(targets.values(), target => target.document));
    expect(documents.size).toBe(1);
    expect(Array.from(documents)[0]?.root.title).toBe('Map');
    expect(reader.reads('Map.md')).toBe(true);
    expect(reader.reads('Plain.md')).toBe(false);
  });

  it('keeps the same document while the note is unchanged and the ids across an edit of it, and drops a note that stopped being a map', async () => {
    const { app, reader } = setup({ 'Host.md': HOST, 'Map.md': MAP });
    const host = parseMarkdown(HOST, 'Host');
    const first = await reader.read(host, 'Host.md');
    const again = await reader.read(host, 'Host.md');
    expect(sameTargets(first, again)).toBe(true);
    expect(Array.from(again.values())[0]?.document).toBe(Array.from(first.values())[0]?.document);
    app.put('Map.md', MAP.replace('- 記録する', '- 記録する\n  - 日誌'));
    const edited = await reader.read(host, 'Host.md');
    expect(sameTargets(first, edited)).toBe(false);
    const before = Array.from(first.values())[0]?.document;
    const after = Array.from(edited.values())[0]?.document;
    expect(after?.nodes.find(node => node.title === '回復する')?.id).toBe(before?.nodes.find(node => node.title === '回復する')?.id);
    expect(after?.nodes.map(node => node.title)).toEqual(['講座', '回復する', '記録する', '日誌']);
    // The cache says map, the text does not (an unsaved edit that dropped `mappy: true`): a link.
    app.put('Map.md', MAP.replace('mappy: true', 'mappy: "true"'));
    const dropped = await reader.read(host, 'Host.md');
    expect(dropped.size).toBe(0);
    expect(reader.reads('Map.md')).toBe(false);
  });

  it('makes the items of an unreadable note links and reads one call after another', async () => {
    const { app, reader } = setup({ 'Host.md': HOST, 'Map.md': MAP });
    const host = parseMarkdown(HOST, 'Host');
    const read = app.vault.read;
    app.vault.read = () => Promise.reject(new Error('boom'));
    expect((await reader.read(host, 'Host.md')).size).toBe(0);
    app.vault.read = read;
    // Two overlapping reads parse the note once: both resolve to the same document.
    const [one, two] = await Promise.all([reader.read(host, 'Host.md'), reader.read(host, 'Host.md')]);
    expect(one.size).toBe(3);
    expect(sameTargets(one, two)).toBe(true);
  });
});

describe('sameTargets', () => {
  it('compares by item, document identity, path and heading', () => {
    const document = parseMarkdown(MAP, 'Map');
    const other = parseMarkdown(MAP, 'Map');
    const base = new Map([['a', { path: 'Map.md', subpath: '', document }]]);
    expect(sameTargets(base, new Map([['a', { path: 'Map.md', subpath: '', document }]]))).toBe(true);
    expect(sameTargets(base, new Map([['a', { path: 'Map.md', subpath: '', document: other }]]))).toBe(false);
    expect(sameTargets(base, new Map([['a', { path: 'Map.md', subpath: '#x', document }]]))).toBe(false);
    expect(sameTargets(base, new Map([['b', { path: 'Map.md', subpath: '', document }]]))).toBe(false);
    expect(sameTargets(base, new Map())).toBe(false);
  });
});
