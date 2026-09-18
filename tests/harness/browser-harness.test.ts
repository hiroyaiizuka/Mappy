// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { parseMarkdown, projectMap } from '../../src/core/markdown';
import { readTopicPositions } from '../../src/core/topics';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp, parseFrontmatter } from '../../harness/browser/app';
import { FIXTURES, SAMPLE_IMAGE, findFixture } from '../../harness/browser/fixtures';
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
      'Fixtures/performance-10.md', 'Fixtures/performance-100.md', 'Fixtures/performance-500.md', 'Fixtures/performance-2000.md',
      ...['list', 'deep', 'wide', 'japanese', 'links'].flatMap(shape => performanceNodeCounts.map(count => `Fixtures/performance-${count}-${shape}.md`)),
    ]);
    expect(FIXTURES.filter(fixture => !fixture.performance).map(fixture => fixture.id))
      .toEqual(['heading-document', 'roundtrip-edge-cases', 'uneven-branches', 'free-topics']);
    expect(SAMPLE_IMAGE.url.startsWith('data:image/svg+xml')).toBe(true);
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

  it('keeps edits in memory, notifies the view through modify, and never rewrites frontmatter text', async () => {
    const app = new HarnessApp();
    const source = '---\nmappy: true\ntags: [a, b]\naliases:\n  - "前の名前"\n---\n## Root\n- Child\n';
    const file = app.put('Fixtures/map.md', source);
    const modified = vi.fn();
    app.vault.on('modify', modified);
    expect(app.metadataCache.getFileCache(file)?.frontmatter).toEqual({ mappy: true, tags: ['a', 'b'], aliases: ['前の名前'] });
    await app.vault.process(file, current => `${current}- Added\n`);
    expect(modified).toHaveBeenCalledExactlyOnceWith(file);
    expect(app.content(file)).toContain('- Added');
    await app.fileManager.processFrontMatter(file, properties => { properties['mappy-layout'] = 'timeline'; });
    expect(app.metadataCache.getFileCache(file)?.frontmatter?.['mappy-layout']).toBe('timeline');
    expect(app.content(file)).not.toContain('mappy-layout');
    expect(app.activity.at(-1)?.kind).toBe('frontmatter');
    expect(parseFrontmatter('no frontmatter')).toBeUndefined();
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
