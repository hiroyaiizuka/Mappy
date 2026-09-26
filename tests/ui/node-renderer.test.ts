// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer, type App } from 'obsidian';
import { projectCalls } from '../../src/core/calls';
import { parseMarkdown, projectMap, type MindDocument } from '../../src/core/markdown';
import { NodeRenderer } from '../../src/ui/node-renderer';
import { accessibleDescription, accessibleName } from './accessible-name';

vi.mock('obsidian', () => {
  class Component {
    private children = new Set<Component>();
    addChild<T extends Component>(child: T): T { this.children.add(child); return child; }
    removeChild<T extends Component>(child: T): T { this.children.delete(child); return child; }
    registerDomEvent(): void { /* Rendering completion is awaited by each test. */ }
  }
  return {
    Component,
    MarkdownRenderer: { render: vi.fn((_app: App, markdown: string, element: HTMLElement) => {
      element.textContent = markdown;
      return Promise.resolve();
    }) },
    setIcon: vi.fn((element: HTMLElement, icon: string) => { element.dataset.icon = icon; }),
  };
});

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

/** Apply the small Obsidian DOM surface to these elements, never global prototypes. */
function dom<T extends HTMLElement>(element: T): T {
  Object.defineProperty(element, 'win', { value: window });
  element.empty = () => { element.replaceChildren(); };
  element.setText = value => { element.replaceChildren(value); };
  element.hasClass = value => element.classList.contains(value);
  element.toggleClass = (value, enabled) => {
    for (const name of Array.isArray(value) ? value : [value]) element.classList.toggle(name, enabled);
  };
  element.createEl = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: DomElementInfo | string,
    callback?: (child: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] => {
    const child = dom(document.createElement(tag));
    const info = typeof options === 'string' ? { cls: options } : options;
    if (info?.cls) child.classList.add(...(Array.isArray(info.cls) ? info.cls : info.cls.split(' ')));
    if (info?.text !== undefined) child.setText(info.text);
    for (const [name, value] of Object.entries(info?.attr ?? {})) {
      if (value !== null) child.setAttribute(name, String(value));
    }
    element.append(child);
    callback?.(child);
    return child;
  };
  element.createDiv = (options, callback) => element.createEl('div', options, callback);
  element.createSpan = (options, callback) => element.createEl('span', options, callback);
  return element;
}

function setup(source: string) {
  const parsed = parseMarkdown(source, 'File root');
  const layer = dom(document.createElement('div'));
  document.body.append(layer);
  const changed = vi.fn();
  const renderer = new NodeRenderer({} as App, layer, changed);
  return { parsed, renderer, changed };
}

function id(document: MindDocument, title: string): string {
  const node = document.nodes.find(value => value.title === title);
  if (!node) throw new Error(`Missing fixture node: ${title}`);
  return node.id;
}

describe('NodeRenderer hierarchy and folding appearance', () => {
  it('styles the actual H2 root and its children by tree depth, including skipped heading levels', () => {
    const { parsed, renderer } = setup('## Course\n#### Stage\n##### Detail\n');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), {
      visualRootId: id(parsed, 'Course'), mode: 'timeline',
    });
    expect(renderer.entries.get(id(parsed, 'Course'))?.element.classList.contains('is-root')).toBe(true);
    expect(renderer.entries.get(id(parsed, 'Stage'))?.element.classList.contains('is-stage')).toBe(true);
    expect(renderer.entries.get(id(parsed, 'Detail'))?.element.classList.contains('is-stage')).toBe(false);
    expect(renderer.entries.get(id(parsed, 'Stage'))?.element.classList.contains('is-timeline')).toBe(true);
    expect(renderer.entries.get(id(parsed, 'Stage'))?.element.classList.contains('is-hierarchy')).toBe(false);
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'hierarchy' });
    for (const title of ['Course', 'Stage', 'Detail']) {
      expect(renderer.entries.get(id(parsed, title))?.element.classList.contains('is-hierarchy')).toBe(true);
      expect(renderer.entries.get(id(parsed, title))?.element.classList.contains('is-timeline')).toBe(false);
      expect(renderer.entries.get(id(parsed, title))?.element.classList.contains('is-balanced')).toBe(false);
    }
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'balanced' });
    for (const title of ['Course', 'Stage', 'Detail']) {
      expect(renderer.entries.get(id(parsed, title))?.element.classList.contains('is-balanced')).toBe(true);
      expect(renderer.entries.get(id(parsed, title))?.element.classList.contains('is-hierarchy')).toBe(false);
    }
  });

  it('does not make every H1 a root when a virtual file root is displayed', () => {
    const { parsed, renderer } = setup('# First\n## Detail\n# Second\n');
    renderer.update([parsed.root, ...parsed.nodes], parsed, 'Course.md', new Set(), {
      visualRootId: parsed.root.id, mode: 'mindmap',
    });
    expect(renderer.entries.get(parsed.root.id)?.element.classList.contains('is-root')).toBe(true);
    expect(renderer.entries.get(id(parsed, 'First'))?.element.classList.contains('is-root')).toBe(false);
    expect(renderer.entries.get(id(parsed, 'First'))?.element.classList.contains('is-stage')).toBe(true);
  });

  it('styles free topics as roots of their own trees and their children as stages', () => {
    const { parsed, renderer } = setup('## Body\n- Branch\n\n## Topic\n- Under topic\n  - Deep\n');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), {
      visualRootId: id(parsed, 'Body'), topicIds: new Set([id(parsed, 'Topic')]), mode: 'mindmap',
    });
    const classes = (title: string): string[] => Array.from(renderer.entries.get(id(parsed, title))?.element.classList ?? []);
    expect(classes('Body')).toContain('is-root');
    expect(classes('Body')).not.toContain('is-topic');
    expect(classes('Topic')).toEqual(expect.arrayContaining(['is-root', 'is-topic']));
    expect(classes('Topic')).not.toContain('is-stage');
    expect(classes('Under topic')).toContain('is-stage');
    expect(classes('Deep')).not.toContain('is-stage');
    // Without the topic set, later H2 sections fall back to plain nodes, never to stages of the body.
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Body'), mode: 'mindmap' });
    expect(classes('Topic')).not.toContain('is-root');
    expect(classes('Topic')).not.toContain('is-stage');
  });

  it('marks a node without text as empty, for the box an emptied draft shares (LEV-203)', () => {
    const source = '## Body\n- \n-   \n- Text\n';
    const { renderer } = setup(source);
    const parsed = parseMarkdown(source, 'File root');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Body'), mode: 'mindmap' });
    const empty = parsed.nodes.filter(node => node.title === '').map(node => renderer.entries.get(node.id)?.element.classList.contains('is-empty'));
    expect(empty).toEqual([true, true]);
    expect(renderer.entries.get(id(parsed, 'Text'))?.element.classList.contains('is-empty')).toBe(false);
    // Named later: the mark goes.
    const renamed = parseMarkdown('## Body\n- 名前\n-   \n- Text\n', 'File root', parsed);
    renderer.update(renamed.nodes, renamed, 'Course.md', new Set(), { visualRootId: id(renamed, 'Body'), mode: 'mindmap' });
    expect(renderer.entries.get(id(renamed, '名前'))?.element.classList.contains('is-empty')).toBe(false);
  });

  it('shows every hidden descendant in the collapsed badge, including a nested collapsed branch', () => {
    const { parsed, renderer } = setup('## Course\n### Stage\n#### One\n##### Deep\n#### Two\n##### Deep two\n');
    const stageId = id(parsed, 'Stage');
    const visible = parsed.nodes.filter(node => ['Course', 'Stage'].includes(node.title));
    renderer.update(visible, parsed, 'Course.md', new Set([stageId, id(parsed, 'One')]), {
      visualRootId: id(parsed, 'Course'), mode: 'timeline',
    });
    const entry = renderer.entries.get(stageId);
    expect(entry?.toggle.textContent).toBe('4');
    expect(entry?.toggle.getAttribute('aria-label')).toBe('4 個のノードを展開');
    expect(entry?.element.getAttribute('aria-expanded')).toBe('false');
    expect(entry?.element.classList.contains('is-collapsed')).toBe(true);
  });

  it('clears the count on expansion and uses a small minus icon inside its own hover control', () => {
    const { parsed, renderer } = setup('## Course\n### Stage\n#### Detail\n');
    const options = { visualRootId: id(parsed, 'Course'), mode: 'timeline' as const };
    const stageId = id(parsed, 'Stage');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set([stageId]), options);
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), options);
    const entry = renderer.entries.get(stageId);
    expect(entry?.element.classList.contains('is-collapsed')).toBe(false);
    expect(entry?.element.getAttribute('aria-expanded')).toBe('true');
    expect(entry?.toggle.textContent).toBe('');
    expect(entry?.toggle.querySelector<HTMLElement>('.mappy-node-toggle-mark')?.dataset.icon).toBe('minus');
    expect(entry?.toggle.getAttribute('aria-label')).toBe('折りたたみ');
    expect(renderer.entries.get(id(parsed, 'Detail'))?.toggle.hidden).toBe(true);
  });

  it('positions the hover control at the layout branch junction, including node borders', () => {
    const { parsed, renderer } = setup('## Course\n### Stage\n#### Detail\n');
    const stageId = id(parsed, 'Stage');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), {
      visualRootId: id(parsed, 'Course'), mode: 'mindmap',
    });
    const entry = renderer.entries.get(stageId);
    if (!entry) throw new Error('Missing stage');
    Object.defineProperty(entry.element, 'clientLeft', { value: 2 });
    Object.defineProperty(entry.element, 'clientTop', { value: 2 });
    renderer.place([{ id: stageId, x: 100, y: 40, width: 240, height: 50 }], [
      { id: stageId, x: 370, y: 65 },
    ]);
    expect(entry.toggle.style.left).toBe('268px');
    expect(entry.toggle.style.top).toBe('23px');
    expect(entry.toggle.style.width).toBe('28px');
    expect(entry.toggle.tabIndex).toBe(0);
    expect(entry.toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('reads every node border before its first style write, so a deep branch never forces a layout per fold', () => {
    // A 40-level single chain: every node but the leaf carries a fold control (LEV-45's performance-2000-deep shape).
    const chain = Array.from({ length: 40 }, (_, index) => `${'  '.repeat(index)}- Level ${index}`);
    const { parsed, renderer } = setup(['## Course', ...chain].join('\n'));
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), {
      visualRootId: id(parsed, 'Course'), mode: 'mindmap',
    });
    // Log layout reads and inline style writes in order; jsdom has no layout, so every layout read is the spy itself.
    const log: string[] = [];
    const layoutRead = vi.fn(() => { log.push('read'); return 1; });
    const layoutProperties = ['clientLeft', 'clientTop', 'clientWidth', 'clientHeight', 'offsetLeft', 'offsetTop',
      'offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight'];
    for (const entry of renderer.entries.values()) {
      for (const element of [entry.element, entry.toggle]) {
        for (const name of layoutProperties) Object.defineProperty(element, name, { get: layoutRead });
        Object.defineProperty(element, 'getBoundingClientRect', { value: layoutRead });
        const style = element.style;
        Object.defineProperty(element, 'style', { get: () => new Proxy(style, {
          set(target, property, value) { log.push(`write ${String(property)}`); return Reflect.set(target, property, value); },
        }) });
      }
    }
    const positioned = parsed.nodes.map((node, index) => ({ id: node.id, x: index * 10, y: index * 20, width: 100, height: 30 }));
    const folds = parsed.nodes.flatMap((node, index) => (node.children.length > 0 ? [{ id: node.id, x: index * 10 + 100, y: index * 20 + 15 }] : []));
    expect(folds).toHaveLength(40);
    renderer.place(positioned, folds);
    // At most one clientLeft and one clientTop per fold, all before the first transform / left / top write.
    expect(layoutRead.mock.calls.length).toBeGreaterThan(0);
    expect(layoutRead.mock.calls.length).toBeLessThanOrEqual(folds.length * 2);
    expect(log.lastIndexOf('read')).toBeLessThan(log.findIndex(item => item.startsWith('write')));
    expect(log.filter(item => item === 'write transform')).toHaveLength(positioned.length);
    const stage = renderer.entries.get(id(parsed, 'Level 0'));
    expect(stage?.element.style.transform).toBe('translate(10px, 20px)');
    expect(stage?.toggle.style.left).toBe('99px');
    expect(stage?.toggle.style.top).toBe('14px');
    expect(renderer.entries.get(id(parsed, 'Level 39'))?.toggle.style.left).toBe('');
  });

  it('uses provided timeline stem coordinates rather than a fixed node-side offset', () => {
    const { parsed, renderer } = setup('## Course\n### Stage\n#### Detail\n');
    const stageId = id(parsed, 'Stage');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), {
      visualRootId: id(parsed, 'Course'), mode: 'timeline',
    });
    renderer.place([{ id: stageId, x: 200, y: 0, width: 150, height: 60 }], [
      { id: stageId, x: 275, y: -30 },
    ]);
    const toggle = renderer.entries.get(stageId)?.toggle;
    expect(toggle?.style.left).toBe('75px');
    expect(toggle?.style.top).toBe('-30px');
  });

  it('reserves matching visual and hover widths for a four-digit collapsed count', () => {
    const source = ['## Course', '### Stage', ...Array.from({ length: 1000 }, (_, index) => `#### Detail ${index}`)].join('\n');
    const { parsed, renderer } = setup(source);
    const stageId = id(parsed, 'Stage');
    renderer.update(parsed.nodes.filter(node => node.level <= 3), parsed, 'Course.md', new Set([stageId]), {
      visualRootId: id(parsed, 'Course'), mode: 'timeline',
    });
    const toggle = renderer.entries.get(stageId)?.toggle;
    expect(toggle?.textContent).toBe('1000');
    expect(toggle?.style.width).toBe('36px');
    expect(toggle?.querySelector<HTMLElement>('.mappy-node-toggle-mark')?.style.width).toBe('36px');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('NodeRenderer title rendering', () => {
  it('renders a note transclusion in a title as a link and keeps image embeds, so a node never nests another note', async () => {
    const { parsed, renderer } = setup('## Course\n- ![[Other Map]] と ![[図.png|120]]\n- ![[doc.pdf]]\n');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
    await Promise.resolve();
    const labels = parsed.nodes.map(node => renderer.entries.get(node.id)?.content.querySelector('.mappy-node-label')?.textContent);
    expect(labels).toEqual(['Course', '[[Other Map]] と ![[図.png|120]]', '[[doc.pdf]]']);
    // The identity key still carries the title as written, so the DOM is reused across updates.
    expect(renderer.entries.get(id(parsed, '![[doc.pdf]]'))?.key).toBe('Course.md\0![[doc.pdf]]\0');
  });

  it('draws the nodes of a called map from the called note, marks them read-only, and puts the link mark on the calling item (§5 M12)', async () => {
    const called = parseMarkdown('---\nmappy: true\n---\n## 講座\n[[参考]] を見る\n- 回復する\n  - 睡眠\n- 記録する\n  ![[図.png]]\n', 'Map');
    const { parsed, renderer } = setup('## Course\n- ![[Map]]\n  [[own link]]\n  - own child\n- ![[Other]]\n');
    const caller = id(parsed, '![[Map]]');
    const projection = projectCalls([projectMap(parsed).root], new Map([[caller, { path: 'Maps/Map.md', subpath: '', document: called }]]));
    const root = projection.roots[0];
    if (!root) throw new Error('no root');
    const visible = Array.from(projection.byId.values());
    const appearance = { visualRootId: id(parsed, 'Course'), mode: 'mindmap' as const, sources: projection.sources, trees: [root] };
    renderer.update(visible, parsed, 'Course.md', new Set(), appearance);
    await Promise.resolve();
    const calling = renderer.entries.get(caller);
    expect(calling?.element.classList.contains('is-called')).toBe(true);
    expect(calling?.element.classList.contains('is-called-root')).toBe(true);
    expect(accessibleName(calling?.element as HTMLElement)).toBe('講座');
    // The source is read after the name, not drawn on hover over the node below (LEV-199).
    expect(calling?.element.hasAttribute('title')).toBe(false);
    expect(accessibleDescription(calling?.element as HTMLElement)).toBe('呼び出し元: Maps/Map.md');
    // The calling item is the host's own node, edited as any other: not read-only, unlike the nodes grafted under it.
    expect(calling?.element.hasAttribute('aria-readonly')).toBe(false);
    expect(calling?.content.querySelector('.mappy-node-call-mark')?.getAttribute('data-icon')).toBe('link');
    expect(calling?.content.querySelector('.mappy-node-label')?.textContent).toBe('講座');
    // The calling item's attachments are its own item's body (what this map edits), not the called root's.
    expect(calling?.key).toBe('Maps/Map.md\0講座\0[[own link]]\0called-root');
    const grafted = visible.find(node => node.title === '記録する');
    const entry = renderer.entries.get(grafted?.id ?? '');
    expect(entry?.element.classList.contains('is-called')).toBe(true);
    expect(entry?.element.classList.contains('is-called-root')).toBe(false);
    expect(entry?.element.getAttribute('aria-readonly')).toBe('true');
    expect(entry?.element.hasAttribute('title')).toBe(false);
    expect(accessibleDescription(entry?.element as HTMLElement)).toBe('呼び出し元: Maps/Map.md');
    expect(entry?.content.querySelector('.mappy-node-call-mark')).toBeNull();
    expect(entry?.key).toBe('Maps/Map.md\0記録する\0![[図.png]]');
    // The host's own nodes stay as they were: the own child under the calling item, the unresolved call a link.
    const own = renderer.entries.get(id(parsed, 'own child'));
    expect(own?.element.classList.contains('is-called')).toBe(false);
    expect(own?.element.hasAttribute('aria-describedby')).toBe(false);
    expect(renderer.entries.get(id(parsed, '![[Other]]'))?.content.querySelector('.mappy-node-label')?.textContent).toBe('[[Other]]');
    // Fold counts come from the trees shown: the calling item hides the three called nodes and its own child.
    renderer.update(visible.filter(node => !projection.sources.has(node.id) || node.id === caller), parsed, 'Course.md', new Set([caller]), appearance);
    expect(calling?.toggleMark.textContent).toBe('4');
    // Once the call is gone, the same node is redrawn as the link it is written as.
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
    await Promise.resolve();
    expect(calling?.element.classList.contains('is-called')).toBe(false);
    expect(calling?.element.hasAttribute('aria-describedby')).toBe(false);
    expect(calling?.content.querySelector('.mappy-node-call-mark')).toBeNull();
    expect(calling?.content.querySelector('.mappy-node-label')?.textContent).toBe('[[Map]]');
    expect(calling?.key).toBe('Course.md\0![[Map]]\0[[own link]]');
  });
});

describe('NodeRenderer node names (LEV-199: no title tooltip over the node below)', () => {
  // Obsidian's desktop app draws any element's `aria-label` as a black tooltip on hover. On a node that is the title
  // already on screen, and it covers the node below — the input of the node being written there. The name stays
  // for screen readers (§5 M3) through `aria-labelledby`, which Obsidian does not draw.
  it('names every node through aria-labelledby, never aria-label or title, the empty one as 空のノード', async () => {
    const { parsed, renderer } = setup('## Course\n- 選択肢を出す\n- \n');
    const empty = parsed.nodes.find(node => node.title === '');
    if (!empty) throw new Error('Missing fixture node: the empty one');
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
    await Promise.resolve();
    const names = new Map<string, string>();
    for (const [nodeId, entry] of renderer.entries) {
      expect(entry.element.hasAttribute('aria-label')).toBe(false);
      expect(entry.element.hasAttribute('title')).toBe(false);
      expect(entry.element.hasAttribute('aria-describedby')).toBe(false);
      names.set(nodeId, accessibleName(entry.element));
    }
    expect(names.get(id(parsed, 'Course'))).toBe('Course');
    expect(names.get(id(parsed, '選択肢を出す'))).toBe('選択肢を出す');
    expect(names.get(empty.id)).toBe('空のノード');
    // The name is not drawn: the rendered label is the only text on screen, and the node's size is the label's.
    const element = renderer.entries.get(id(parsed, '選択肢を出す'))?.element;
    const target = element?.ownerDocument.getElementById(element.getAttribute('aria-labelledby') ?? '');
    expect(target?.hidden).toBe(true);
    expect(element?.contains(target ?? null)).toBe(true);
    // Neither while the node is being edited.
    renderer.editing(id(parsed, '選択肢を出す'), true);
    expect(element?.hasAttribute('aria-label')).toBe(false);
    expect(accessibleName(element as HTMLElement)).toBe('選択肢を出す');
  });

  it('follows a rename, and keeps the ids unique across two maps of the same note', () => {
    const { parsed, renderer } = setup('## Course\n- one\n');
    const appearance = { visualRootId: id(parsed, 'Course'), mode: 'mindmap' as const };
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), appearance);
    const element = renderer.entries.get(id(parsed, 'one'))?.element as HTMLElement;
    // An update that changes nothing leaves the name's text node alone: a large map's refresh is not a mutation per node.
    const text = element.querySelector('.mappy-node-name')?.firstChild;
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), appearance);
    expect(element.querySelector('.mappy-node-name')?.firstChild).toBe(text);
    const renamed = parseMarkdown('## Course\n- uno\n', 'File root', parsed);
    renderer.update(renamed.nodes, renamed, 'Course.md', new Set(), appearance);
    expect(renderer.entries.get(id(renamed, 'uno'))?.element).toBe(element);
    expect(element.hasAttribute('aria-label')).toBe(false);
    expect(accessibleName(element)).toBe('uno');
    // A second view (or an embed) of the same note draws the same node ids: the name elements' ids must still differ.
    const layer = dom(document.createElement('div'));
    document.body.append(layer);
    const second = new NodeRenderer({} as App, layer, vi.fn());
    second.update(renamed.nodes, renamed, 'Course.md', new Set(), appearance);
    const ids = [...renderer.entries.values(), ...second.entries.values()]
      .flatMap(entry => Array.from(entry.element.querySelectorAll('[id]'), item => item.id));
    // Two maps, two nodes each, a name element per node (no description: nothing here is called).
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
    for (const value of ids) expect(document.querySelectorAll(`[id="${CSS.escape(value)}"]`)).toHaveLength(1);
    expect(accessibleName(second.entries.get(id(renamed, 'uno'))?.element as HTMLElement)).toBe('uno');
  });
});

describe('NodeRenderer idle (§5 M13: the export waits for the renders in flight)', () => {
  /** How long a wait tolerates no render finishing (the product passes EXPORT_RENDER_WAIT_MS). */
  const STALL = 2000;
  /** Renders whose end the test decides: one deferred promise per call, in call order. */
  function deferRenders(): { settle: (index: number, outcome?: 'resolve' | 'reject') => Promise<void>; calls: () => number } {
    const pending: { resolve: () => void; reject: (reason: Error) => void }[] = [];
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation((_app: App, markdown: string, element: HTMLElement) =>
      new Promise<void>((resolve, reject) => { pending.push({ resolve: () => { element.textContent = markdown; resolve(); }, reject }); }));
    return {
      settle: async (index, outcome = 'resolve') => {
        const call = pending[index];
        if (!call) throw new Error(`No render ${index}`);
        if (outcome === 'resolve') call.resolve(); else call.reject(new Error('render failed'));
        // The renderer's own then/catch/finally chain runs over a few microtasks.
        for (let round = 0; round < 6; round += 1) await Promise.resolve();
      },
      calls: () => pending.length,
    };
  }

  /** Whether `promise` has settled by now, without waiting on it. */
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(() => { done = true; });
    for (let round = 0; round < 6; round += 1) await Promise.resolve();
    return done;
  }

  it('resolves at once with nothing in flight, and only after every render finished otherwise, with the layout frame already asked for', async () => {
    const { parsed, renderer, changed } = setup('## Course\n- one\n- two\n');
    const renders = deferRenders();
    await expect(renderer.idle(STALL)).resolves.toBe(true);
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
    expect(renders.calls()).toBe(3);
    const idle = renderer.idle(STALL);
    const order: string[] = [];
    changed.mockImplementation(() => { order.push('changed'); });
    void idle.then(() => { order.push('idle'); });
    await renders.settle(0);
    await renders.settle(1);
    expect(await settled(idle)).toBe(false);
    await renders.settle(2);
    expect(await settled(idle)).toBe(true);
    await expect(idle).resolves.toBe(true);
    expect(order).toEqual(['changed', 'changed', 'changed', 'idle']);
    expect(renderer.entries.get(id(parsed, 'two'))?.content.querySelector('.mappy-node-label')?.textContent).toBe('two');
    // Nothing in flight again: the next wait is immediate.
    await expect(renderer.idle(STALL)).resolves.toBe(true);
  });

  it('gives up (false) when no render finishes for the stall time, keeps waiting while they do, and asks for a frame when a pending node is removed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { parsed, renderer, changed } = setup('## Course\n- one\n- two\n');
      const renders = deferRenders();
      renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
      // Slow but alive: a render finishes within every stall window, so the wait goes on past one window.
      const slow = renderer.idle(STALL);
      await vi.advanceTimersByTimeAsync(STALL - 1);
      await renders.settle(0);
      await vi.advanceTimersByTimeAsync(STALL - 1);
      await renders.settle(1);
      await vi.advanceTimersByTimeAsync(STALL - 1);
      expect(await settled(slow)).toBe(false);
      await renders.settle(2);
      await expect(slow).resolves.toBe(true);
      // Stalled: nothing finishes for a whole window.
      const again = parseMarkdown('## Course\n- one\n- two\n- three\n', 'File root', parsed);
      renderer.update(again.nodes, again, 'Course.md', new Set(), { visualRootId: id(again, 'Course'), mode: 'mindmap' });
      const stalled = renderer.idle(STALL);
      await vi.advanceTimersByTimeAsync(STALL - 1);
      expect(await settled(stalled)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(stalled).resolves.toBe(false);
      // The pending node is removed: that is a change (a frame is asked for), and a wait started before it ends now.
      const waiting = renderer.idle(STALL);
      changed.mockClear();
      renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
      expect(changed).toHaveBeenCalledTimes(1);
      await expect(waiting).resolves.toBe(true);
      // The given-up wait left no waiter behind: its late render ends nothing twice, and the next wait is immediate.
      await renders.settle(3);
      await expect(renderer.idle(STALL)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for a render superseded by a re-render or a removal, and a late end of it does not cut the new wait short', async () => {
    const { parsed, renderer, changed } = setup('## Course\n- one\n- two\n');
    const renders = deferRenders();
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
    await renders.settle(0);
    // `one` is renamed (its entry re-renders, render 3), `two` is gone: renders 1 and 2 no longer hold the map's picture.
    const renamed = parseMarkdown('## Course\n- uno\n', 'File root', parsed);
    renderer.update(renamed.nodes, renamed, 'Course.md', new Set(), { visualRootId: id(renamed, 'Course'), mode: 'mindmap' });
    expect(renders.calls()).toBe(4);
    const idle = renderer.idle(STALL);
    expect(await settled(idle)).toBe(false);
    changed.mockClear();
    await renders.settle(1);
    await renders.settle(2);
    // Their late ends neither redraw (the entry moved on) nor end the wait for the render that replaced them.
    expect(changed).not.toHaveBeenCalled();
    expect(await settled(idle)).toBe(false);
    await renders.settle(3);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await settled(idle)).toBe(true);
    expect(renderer.entries.get(id(renamed, 'uno'))?.content.querySelector('.mappy-node-label')?.textContent).toBe('uno');
  });

  it('ends the wait when a render fails (the title is shown as plain text) and when the renderer unloads', async () => {
    const { parsed, renderer, changed } = setup('## Course\n- one\n');
    const renders = deferRenders();
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
    await renders.settle(0);
    const idle = renderer.idle(STALL);
    await renders.settle(1, 'reject');
    expect(await settled(idle)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(renderer.entries.get(id(parsed, 'one'))?.content.querySelector('.mappy-node-label')?.textContent).toBe('one');
    // A render still in flight when the view closes: the export's wait must not outlive the renderer.
    const again = parseMarkdown('## Course\n- one\n- late\n', 'File root', parsed);
    renderer.update(again.nodes, again, 'Course.md', new Set(), { visualRootId: id(again, 'Course'), mode: 'mindmap' });
    const closing = renderer.idle(STALL);
    expect(await settled(closing)).toBe(false);
    renderer.onunload();
    await expect(closing).resolves.toBe(true);
    expect(renderer.entries.size).toBe(0);
  });

  it('keeps a title\'s `<br>` as a break when its render fails and the text is shown plain (LEV-202)', async () => {
    const { parsed, renderer } = setup('## Course\n- 温泉 <br> 旅行\n');
    const renders = deferRenders();
    renderer.update(parsed.nodes, parsed, 'Course.md', new Set(), { visualRootId: id(parsed, 'Course'), mode: 'mindmap' });
    await renders.settle(0);
    await renders.settle(1, 'reject');
    const label = renderer.entries.get(id(parsed, '温泉 <br> 旅行'))?.content.querySelector('.mappy-node-label');
    expect(label?.querySelectorAll('br')).toHaveLength(1);
    expect(label?.textContent).toBe('温泉旅行');
  });
});
