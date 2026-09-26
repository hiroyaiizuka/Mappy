// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { writeMapLayout } from '../../src/obsidian/frontmatter';
import { parseMarkdown, projectMap } from '../../src/core/markdown';
import { readTopicPositions } from '../../src/core/topics';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp, parseFrontmatter } from '../../harness/browser/app';
import { EMBED_HOSTS, EMBED_TARGETS, FIXTURES, SAMPLE_IMAGE, findFixture, findHost } from '../../harness/browser/fixtures';
import { embedOnlyTitle, frontmatterReader, readMapFromSource } from '../../src/core/embed';
import { Component, Events, MarkdownRenderer } from '../../harness/browser/obsidian';
import { performanceFixtureMatrix, performanceNodeCounts } from '../../scripts/performance-fixtures.mjs';

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

function fixtureSource(id: string): string {
  const fixture = findFixture(id);
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.source;
}

describe('browser harness fixtures', () => {
  it('embeds the generated performance documents with exactly 10/100/500/2,000 nodes in every shape', () => {
    expect(performanceNodeCounts).toEqual([10, 100, 500, 2000]);
    for (const { id, nodeCount, shape } of performanceFixtureMatrix()) {
      const parsed = parseMarkdown(fixtureSource(id), id);
      expect(parsed.nodes, id).toHaveLength(nodeCount);
      expect(parsed.root.children, id).toHaveLength(1);
      expect(findFixture(id)?.performance, id).toEqual({ nodeCount, shape: shape.id });
    }
  });

  it('covers Japanese, duplicate names, links, images, code blocks and uneven branches', () => {
    const uneven = parseMarkdown(fixtureSource('uneven-branches'), 'uneven-branches');
    expect(uneven.format).toBe('list');
    const titles = uneven.nodes.map(node => node.title);
    expect(titles.filter(title => title === '同じ名前')).toHaveLength(2);
    expect(titles).toContain('八段目');
    expect(titles.filter(title => title.startsWith('兄弟 '))).toHaveLength(24);
    expect(titles).not.toContain('本文のコードブロックは見出しにしない');
    expect(titles.some(title => /[ぁ-んァ-ン一-龯]/u.test(title))).toBe(true);
    const roundtrip = parseMarkdown(fixtureSource('roundtrip-edge-cases'), 'roundtrip-edge-cases');
    expect(roundtrip.nodes.filter(node => node.title === '同じ名前')).toHaveLength(2);
    expect(roundtrip.nodes.map(node => node.title)).not.toContain('コードの中の見出し');
    expect(fixtureSource('heading-document')).toContain('![[sample-image.svg]]');
    expect(fixtureSource('heading-document')).toContain('[[roundtrip-edge-cases|別名付きノート]]');
  });

  it('shows the multi-H2 fixture as one body with three free topics instead of a virtual root', () => {
    const doc = parseMarkdown(fixtureSource('free-topics'), 'free-topics');
    const { root, topics } = projectMap(doc);
    expect(root.title).toBe('講座の本体');
    expect(topics.map(topic => topic.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック']);
    expect([...readTopicPositions(doc.source).keys()]).toEqual(['参考資料', '補足: 用語', '消えた見出し']);
  });

  it('uses the same vault paths as test-vault/Fixtures', () => {
    expect(FIXTURES.map(fixture => fixture.path)).toEqual([
      'Fixtures/heading-document.md', 'Fixtures/roundtrip-edge-cases.md', 'Fixtures/uneven-branches.md', 'Fixtures/free-topics.md',
      'Fixtures/embed-nodes.md', 'Fixtures/embed-cycle.md', 'Fixtures/timeline-stages.md',
      'Fixtures/performance-10.md', 'Fixtures/performance-100.md', 'Fixtures/performance-500.md', 'Fixtures/performance-2000.md',
      ...['list', 'deep', 'wide', 'japanese', 'links'].flatMap(shape => performanceNodeCounts.map(count => `Fixtures/performance-${count}-${shape}.md`)),
    ]);
    expect(FIXTURES.filter(fixture => !fixture.performance).map(fixture => fixture.id))
      .toEqual(['heading-document', 'roundtrip-edge-cases', 'uneven-branches', 'free-topics', 'embed-nodes', 'embed-cycle', 'timeline-stages']);
    expect(SAMPLE_IMAGE.url.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('keeps the embed host and its map notes beside the map-view fixtures, in the same vault folder (E31)', () => {
    expect(EMBED_HOSTS.map(host => [host.id, host.path, host.mode])).toEqual([
      ['embed-host', 'Fixtures/embed-host.md', 'reading'], ['embed-host-live', 'Fixtures/embed-host.md', 'live'],
      ['embed-host-live-late', 'Fixtures/embed-host.md', 'live-late'],
    ]);
    expect(findHost('embed-host-live')?.source).toBe(findHost('embed-host')?.source);
    expect(findHost('embed-host-live-late')?.source).toBe(findHost('embed-host')?.source);
    expect(findFixture('embed-host')).toBeUndefined();
    const host = findHost('embed-host');
    if (!host) throw new Error('no host');
    expect(readMapFromSource(host.source)).toBeNull();
    for (const link of ['![[uneven-branches]]', '![[embed-timeline]]', '![[embed-hierarchy]]', '![[embed-hierarchy#同じ名前]]', '![[embed-2000]]',
      '![[heading-document]]', '![[存在しないノート]]', '![[embed-hierarchy#^block]]']) expect(host.source).toContain(link);
    expect(EMBED_TARGETS.map(target => target.path)).toEqual(['Fixtures/embed-timeline.md', 'Fixtures/embed-hierarchy.md', 'Fixtures/embed-2000.md']);
    expect(EMBED_TARGETS.map(target => readMapFromSource(target.source))).toEqual(['timeline', 'hierarchy', 'mindmap']);
    const hierarchy = parseMarkdown(EMBED_TARGETS[1]?.source ?? '', 'embed-hierarchy');
    expect(hierarchy.nodes.filter(node => node.title === '同じ名前')).toHaveLength(2);
    expect(parseMarkdown(EMBED_TARGETS[2]?.source ?? '', 'embed-2000').nodes).toHaveLength(2000);
  });

  it('keeps a map that calls other maps from its nodes, and the map that calls it back (M12, E35)', () => {
    const host = parseMarkdown(fixtureSource('embed-nodes'), 'embed-nodes');
    expect(readMapFromSource(host.source)).toBe('mindmap');
    const calls = host.nodes.map(node => embedOnlyTitle(node.title)).filter((link): link is string => link !== null);
    expect(calls).toEqual([
      'embed-timeline', 'embed-hierarchy#同じ名前', 'embed-2000', 'embed-timeline', 'embed-cycle',
      'embed-nodes', 'heading-document', '存在しないノート', 'embed-hierarchy#^block', 'sample-image.svg',
    ]);
    expect(host.nodes.some(node => node.title === '文中の ![[embed-timeline]] はリンク')).toBe(true);
    const cycle = parseMarkdown(fixtureSource('embed-cycle'), 'embed-cycle');
    expect(readMapFromSource(cycle.source)).toBe('mindmap');
    expect(cycle.nodes.map(node => embedOnlyTitle(node.title))).toEqual([null, 'embed-nodes', null, 'embed-cycle', null]);
  });
});

describe('browser harness Obsidian DOM helpers', () => {
  it('creates elements with classes, attributes and text the way the product expects', () => {
    const host = document.createElement('div');
    const child = host.createDiv({ cls: 'a b', attr: { 'data-node-id': 'n1', tabindex: '0', skipped: null }, text: 'title' });
    expect(child.className).toBe('a b');
    expect(child.dataset.nodeId).toBe('n1');
    expect(child.hasAttribute('skipped')).toBe(false);
    expect(child.textContent).toBe('title');
    child.toggleClass('is-selected', true);
    expect(child.hasClass('is-selected')).toBe(true);
    child.removeClass('is-selected');
    expect(child.hasClass('is-selected')).toBe(false);
    const svg = host.createSvg('svg', { cls: 'edges' });
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(host.win).toBe(window);
    host.empty();
    expect(host.childNodes).toHaveLength(0);
  });

  it('exposes targetNode and instanceOf on events and nodes', () => {
    const button = document.body.createEl('button');
    let seen: Node | null = null;
    button.addEventListener('click', event => { seen = event.targetNode; });
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toBe(button);
    expect(button.instanceOf(HTMLElement)).toBe(true);
    expect(button.instanceOf(SVGElement)).toBe(false);
  });
});

describe('browser harness obsidian mock', () => {
  it('renders links, embeds and reference links with the classes NodeRenderer filters on', async () => {
    const app = new HarnessApp();
    app.put('Fixtures/note.md', '# Note');
    app.put(SAMPLE_IMAGE.path, '', SAMPLE_IMAGE.url);
    const element = document.body.createDiv();
    await MarkdownRenderer.render(
      app.asApp<App>(),
      '[[note|別名]] [[missing]] ![[sample-image.svg|120]] ![[gone.png]] [ext](https://example.com) [ref][x] <b>\n\n[x]: https://example.org',
      element, 'Fixtures/note.md',
    );
    const internal = element.querySelectorAll<HTMLAnchorElement>('a.internal-link');
    expect(Array.from(internal, anchor => anchor.dataset.href)).toEqual(['note', 'missing']);
    expect(internal[0]?.textContent).toBe('別名');
    expect(internal[1]?.classList.contains('is-unresolved')).toBe(true);
    const image = element.querySelector<HTMLImageElement>('.image-embed.is-loaded img');
    expect(image?.getAttribute('src')).toBe(SAMPLE_IMAGE.url);
    expect(image?.getAttribute('width')).toBe('120');
    expect(element.querySelector('.image-embed.mod-empty')?.textContent).toBe('gone.png');
    const external = Array.from(element.querySelectorAll<HTMLAnchorElement>('a.external-link'), anchor => anchor.getAttribute('href'));
    expect(external).toEqual(['https://example.com', 'https://example.org']);
    expect(element.querySelector('b')).toBeNull();
    expect(element.textContent).toContain('<b>');
  });

  it('renders a `<br>` as a break only where Obsidian does: not in code, after a backslash or in a link label (LEV-202)', async () => {
    const app = new HarnessApp();
    const element = document.body.createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '温泉<BR/>旅行 `a<br>b` c\\<br>d [[note|x<br>y]]', element, 'Fixtures/note.md');
    expect(element.querySelectorAll('br')).toHaveLength(1);
    expect(element.textContent).toContain('a<br>b');
    expect(element.textContent).toContain('c\\<br>d');
    expect(element.querySelector('a.internal-link')?.textContent).toBe('x<br>y');
    // Review 3 of LEV-202: a Markdown link's label, an escaped backslash before the tag and a tag with attributes break.
    const more = document.body.createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '[a<br>b](u) c\\\\<br>d e<br class="x">f', more, 'Fixtures/note.md');
    expect(more.querySelectorAll('br')).toHaveLength(3);
    expect(more.querySelector('a.external-link')?.querySelectorAll('br')).toHaveLength(1);
  });

  it('keeps edits in memory and notifies the view through modify', async () => {
    const app = new HarnessApp();
    const source = '---\nmappy: true\ntags: [a, b]\naliases:\n  - "前の名前"\n---\n## Root\n- Child\n';
    const file = app.put('Fixtures/map.md', source);
    const modified = vi.fn();
    app.vault.on('modify', modified);
    expect(app.metadataCache.getFileCache(file)?.frontmatter).toEqual({ mappy: true, tags: ['a', 'b'], aliases: ['前の名前'] });
    await app.vault.process(file, current => `${current}- Added\n`);
    expect(modified).toHaveBeenCalledExactlyOnceWith(file);
    expect(app.content(file)).toContain('- Added');
    expect(parseFrontmatter('no frontmatter')).toBeUndefined();
  });

  /*
   * LEV-214: the page's `processFrontMatter` changed the cache and `activity` only, so a case reading the text after
   * the product's conversion (`writeMapLayout`) saw the note as it was. Rows: what the callback does × the header's shape.
   */
  describe('processFrontMatter rewrites the header in the text', () => {
    async function run(source: string, change: (properties: Record<string, unknown>) => void) {
      const app = new HarnessApp();
      const file = app.put('Fixtures/fm.md', source);
      const modified = vi.fn();
      app.vault.on('modify', modified);
      await app.fileManager.processFrontMatter(file, change);
      return { text: app.content(file), cache: app.metadataCache.getFileCache(file)?.frontmatter, modified, app };
    }

    it('adds a key before the closing line and keeps every other key\'s bytes', async () => {
      const source = '---\n"quoted": x # note\ntags: [a, b]\nmappy: true\n---\n## Root\n';
      const { text, cache, modified } = await run(source, properties => { properties['mappy-layout'] = 'timeline'; });
      expect(text).toBe('---\n"quoted": x # note\ntags: [a, b]\nmappy: true\nmappy-layout: timeline\n---\n## Root\n');
      expect(cache?.['mappy-layout']).toBe('timeline');
      expect(modified).toHaveBeenCalledOnce();
    });

    it('changes a key where it is, list values included', async () => {
      const source = '---\nmappy-layout: timeline\naliases:\n  - 前\nmappy: true\n---\nbody\n';
      const { text } = await run(source, properties => { properties['mappy-layout'] = 'hierarchy'; properties.aliases = ['後', 'a: b']; });
      expect(text).toBe('---\nmappy-layout: hierarchy\naliases:\n  - 後\n  - "a: b"\nmappy: true\n---\nbody\n');
      expect(parseFrontmatter(text)).toEqual({ 'mappy-layout': 'hierarchy', aliases: ['後', 'a: b'], mappy: true });
    });

    it('removes a key with its nested lines and leaves an untouched nested key as it was', async () => {
      const source = fixtureSource('free-topics');
      const withLayout = source.replace(/^---\n/u, '---\nmappy-layout: timeline\n');
      const { text } = await run(withLayout, properties => { delete properties['mappy-layout']; });
      expect(text).toBe(source);
      const released = await run(source, properties => { delete properties.mappy; delete properties['mappy-topics']; });
      const body = source.slice(source.indexOf('\n---\n') + 5);
      expect(released.text).toBe(`---\ntags:\n  - fixture\n---\n${body}`);
      expect(readMapFromSource(released.text)).toBeNull();
    });

    it('drops a header left empty and adds one to a note without it', async () => {
      const released = await run('---\nmappy: true\n---\n## Root\n', properties => { delete properties.mappy; });
      expect(released.text).toBe('## Root\n');
      expect(released.cache).toBeUndefined();
      const converted = await run('## Root\n', properties => { properties.mappy = true; });
      expect(converted.text).toBe('---\nmappy: true\n---\n## Root\n');
      expect(readMapFromSource(converted.text)).toBe('mindmap');
    });

    it('keeps CRLF and leaves the text alone when nothing changes', async () => {
      const crlf = await run('---\r\nmappy: true\r\n---\r\nbody\r\n', properties => { properties['mappy-layout'] = 'timeline'; });
      expect(crlf.text).toBe('---\r\nmappy: true\r\nmappy-layout: timeline\r\n---\r\nbody\r\n');
      const same = await run('---\nmappy: true\n---\nbody\n', properties => { properties.mappy = true; });
      expect(same.text).toBe('---\nmappy: true\n---\nbody\n');
      expect(same.modified).not.toHaveBeenCalled();
    });

    it('takes the product\'s conversion and release through the text (writeMapLayout)', async () => {
      const app = new HarnessApp();
      const file = app.put('Fixtures/plain.md', '## Root\n- Child\n');
      await writeMapLayout(app.asApp<App>(), file as unknown as TFile, 'timeline');
      expect(readMapFromSource(app.content(file))).toBe('timeline');
      await writeMapLayout(app.asApp<App>(), file as unknown as TFile, null);
      expect(app.content(file)).toBe('## Root\n- Child\n');
      // Only this path leaves a `frontmatter` entry; the capture tells a conversion from a button's write by it.
      expect(app.activity.filter(entry => entry.kind === 'frontmatter')).toHaveLength(2);
    });

    // Review 1 of LEV-214: the callback read the header with this page's own reader, not the product's, so a header
    // the product reads as a map could be released to no effect, and a value it misread was written back.
    it.each([
      ['a BOM', '﻿---\nmappy: true\n---\nbody\n', '﻿body\n'],
      ['a `...` closing line', '---\nmappy: true\n...\nbody\n', 'body\n'],
      ['a quoted key', '---\n"mappy": true\ntags: x\n---\nbody\n', '---\ntags: x\n---\nbody\n'],
      ['a space before the colon', '---\nmappy : true\ntags: x\n---\nbody\n', '---\ntags: x\n---\nbody\n'],
    ])('releases a map whose header has %s', async (_shape, source, released) => {
      expect(readMapFromSource(source)).toBe('mindmap');
      const app = new HarnessApp();
      const file = app.put('Fixtures/fm.md', source);
      await writeMapLayout(app.asApp<App>(), file as unknown as TFile, null);
      expect(app.content(file)).toBe(released);
    });

    it('reads what the product reads: a comment, a quoted comma and a nested key reach the callback as they are', async () => {
      const source = '---\nmappy: true # keep\ntags: [a, "b, c"]\nmappy-topics:\n  参考: { mindmap: [1, 2] }\n---\nbody\n';
      let seen: Record<string, unknown> = {};
      const { text } = await run(source, properties => { seen = structuredClone(properties); properties['mappy-layout'] = 'timeline'; });
      expect(seen).toEqual({ mappy: true, tags: ['a', 'b, c'], 'mappy-topics': { 参考: { mindmap: [1, 2] } } });
      expect(text).toBe(source.replace('\n---\nbody', '\nmappy-layout: timeline\n---\nbody'));
      const pushed = await run(source, properties => { (properties.tags as string[]).push('d'); });
      expect(pushed.text).toBe(source.replace('tags: [a, "b, c"]', 'tags:\n  - a\n  - b, c\n  - d'));
      expect(frontmatterReader(pushed.text)?.('tags')).toEqual(['a', 'b, c', 'd']);
    });

    it('converts a note whose leading `---` never closes, as a note without a header', async () => {
      const source = '---\n## Root\n- a\n';
      const { text } = await run(source, properties => { properties.mappy = true; });
      expect(text).toBe(`---\nmappy: true\n---\n${source}`);
    });

    it('quotes a string YAML would read as something else', async () => {
      const values = ['1e3', '0x1F', '0o17', '.inf', '-.inf', '.nan', 'yes', 'Null', '12', 'plain'];
      const { text } = await run('---\nmappy: true\n---\n', properties => { properties.aliases = values; });
      expect(frontmatterReader(text)?.('aliases')).toEqual(values);
      expect(text).toContain('  - plain\n');
    });

    it('keeps a BOM in front of a new header and the header\'s own line endings', async () => {
      expect((await run('﻿## Root\n', properties => { properties.mappy = true; })).text).toBe('﻿---\nmappy: true\n---\n## Root\n');
      const mixed = await run('---\nmappy: true\n---\nbody\r\n', properties => { properties['mappy-layout'] = 'timeline'; });
      expect(mixed.text).toBe('---\nmappy: true\nmappy-layout: timeline\n---\nbody\r\n');
    });
  });

  it('loads children with the parent and releases DOM and event subscriptions on unload', () => {
    const events = new Events();
    const parent = new Component();
    const child = new Component();
    const onload = vi.spyOn(child, 'onload');
    parent.addChild(child);
    expect(onload).not.toHaveBeenCalled();
    parent.load();
    expect(onload).toHaveBeenCalledOnce();
    const late = new Component();
    const lateLoad = vi.spyOn(late, 'onload');
    parent.addChild(late);
    expect(lateLoad).toHaveBeenCalledOnce();
    const callback = vi.fn();
    parent.registerEvent(events.on('modify', callback));
    const button = document.body.createEl('button');
    const clicked = vi.fn();
    parent.registerDomEvent(button, 'click', clicked);
    events.trigger('modify', 1);
    button.click();
    parent.unload();
    events.trigger('modify', 2);
    button.click();
    expect(callback).toHaveBeenCalledExactlyOnceWith(1);
    expect(clicked).toHaveBeenCalledOnce();
  });
});
