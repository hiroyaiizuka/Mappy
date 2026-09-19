// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';
import { NodeRenderer } from '../../src/ui/node-renderer';

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

afterEach(() => { document.body.replaceChildren(); });

/** Apply the small Obsidian DOM surface to these elements, never global prototypes. */
function dom<T extends HTMLElement>(element: T): T {
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
  const renderer = new NodeRenderer({} as App, layer, vi.fn());
  return { parsed, renderer };
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
