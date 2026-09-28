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

describe('CallReader.listen (LEV-221)', () => {
  function writesOf(reader: CallReader): Map<string, { size: number }> {
    return (reader as unknown as { writes: Map<string, { size: number }> }).writes;
  }

  it('records the store\'s writes on a note read here only while listening, and forgets them with the note', async () => {
    const app = new HarnessApp();
    app.put('Host.md', HOST);
    const map = app.put('Map.md', MAP);
    const store = new DocumentStore(app.asApp<App>());
    const reader = new CallReader(app.asApp<App>(), store);
    const host = parseMarkdown(HOST, 'Host');
    await reader.read(host, 'Host.md');
    const at = MAP.indexOf('記録する');
    // A reader nobody listens with (an export, the Excalidraw bridge: one read each) keeps nothing.
    await store.applyLatest(map as never, () => [{ from: at, to: at + 4, text: '記録' }]);
    expect(writesOf(reader).has('Map.md')).toBe(false);
    // A note read before `listen` is recorded from its next read on (the view listens before it reads anything).
    const stop = reader.listen();
    await reader.read(host, 'Host.md');
    const text = app.content(map);
    await store.applyLatest(map as never, () => [{ from: text.indexOf('記録'), to: text.indexOf('記録') + 2, text: '記録する' }]);
    expect(writesOf(reader).get('Map.md')?.size).toBe(1);
    // No longer a map: the parse goes, and the writes that would have led on from it with it.
    app.put('Map.md', MAP.replace('mappy: true', 'mappy: "true"'));
    await reader.read(host, 'Host.md');
    expect(writesOf(reader).has('Map.md')).toBe(false);
    // A map again: recorded again, and let go of when the listener stops.
    app.put('Map.md', MAP);
    await reader.read(host, 'Host.md');
    expect(writesOf(reader).has('Map.md')).toBe(true);
    stop();
    expect(writesOf(reader).size).toBe(0);
    // Stopped twice, the second does nothing, and the reader can listen again and records again (code review 2).
    stop();
    const again = reader.listen();
    await reader.read(host, 'Host.md');
    expect(writesOf(reader).has('Map.md')).toBe(true);
    again();
  });

  it('lets go of a note read while `clear` was asked for only once that read is done (code review 2)', async () => {
    // A read paused on the store when the host stops calling would otherwise put its parse and a new record back after
    // the clear, and nothing would read the note again to let go of them.
    const app = new HarnessApp();
    app.put('Host.md', HOST);
    app.put('Map.md', MAP);
    const store = new DocumentStore(app.asApp<App>());
    const reader = new CallReader(app.asApp<App>(), store);
    const stop = reader.listen();
    const read = store.read.bind(store);
    let answer: () => void = () => undefined;
    const held = new Promise<void>(resolve => { answer = resolve; });
    const spy = vi.spyOn(store, 'read').mockImplementation(async file => { await held; return read(file); });
    const reading = reader.read(parseMarkdown(HOST, 'Host'), 'Host.md');
    await new Promise(resolve => setTimeout(resolve, 0));
    const cleared = reader.clear();
    answer();
    await reading;
    await cleared;
    expect({ reads: reader.reads('Map.md'), kept: writesOf(reader).size }).toEqual({ reads: false, kept: 0 });
    spy.mockRestore();
    stop();
  });

  it('a read or a clear whose host moved on lets go of nothing: the notes the host calls now keep their parse and record (code review 3)', async () => {
    const app = new HarnessApp();
    app.put('Host.md', HOST);
    app.put('Map.md', MAP);
    app.put('Other.md', MAP.replace('講座', '別'));
    const store = new DocumentStore(app.asApp<App>());
    const reader = new CallReader(app.asApp<App>(), store);
    const stop = reader.listen();
    // The host now calls Other; a read (or a clear) of the document it showed before, still queued, must not drop Other.
    await reader.read(parseMarkdown('---\nmappy: true\n---\n## ホスト\n- ![[Other]]\n', 'Host'), 'Host.md');
    expect(writesOf(reader).has('Other.md')).toBe(true);
    await reader.read(parseMarkdown(HOST, 'Host'), 'Host.md', () => false);
    // Current as it starts, moved on by the time it would let go (the host published another document meanwhile).
    let asked = 0;
    await reader.read(parseMarkdown(HOST, 'Host'), 'Host.md', () => ++asked === 1);
    expect(asked).toBe(2);
    await reader.clear(() => false);
    expect({ reads: reader.reads('Other.md'), kept: writesOf(reader).has('Other.md') }).toEqual({ reads: true, kept: true });
    stop();
  });

  it('a second listen takes over, and the first one\'s stop leaves it be (code review 3)', async () => {
    const { reader } = setup({ 'Host.md': HOST, 'Map.md': MAP });
    const first = reader.listen();
    const second = reader.listen();
    await reader.read(parseMarkdown(HOST, 'Host'), 'Host.md');
    first();
    expect(writesOf(reader).has('Map.md')).toBe(true);
    second();
    expect(writesOf(reader).size).toBe(0);
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
