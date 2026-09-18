// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDrop } from '../../src/core/commands';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';
import { MapEvents, type MapActions } from '../../src/ui/map-events';

const originalTargetNode = Object.getOwnPropertyDescriptor(UIEvent.prototype, 'targetNode');
const originalInstanceOf = Object.getOwnPropertyDescriptor(Node.prototype, 'instanceOf');
const components = new Set<MapEvents>();

beforeAll(() => {
  Object.defineProperty(UIEvent.prototype, 'targetNode', {
    configurable: true,
    get(this: UIEvent): Node | null { return this.target instanceof Node ? this.target : null; },
  });
  Object.defineProperty(Node.prototype, 'instanceOf', {
    configurable: true,
    value(this: Node, constructor: new () => unknown): boolean { return this instanceof constructor; },
  });
});

afterAll(() => {
  if (originalTargetNode) Object.defineProperty(UIEvent.prototype, 'targetNode', originalTargetNode);
  else Reflect.deleteProperty(UIEvent.prototype, 'targetNode');
  if (originalInstanceOf) Object.defineProperty(Node.prototype, 'instanceOf', originalInstanceOf);
  else Reflect.deleteProperty(Node.prototype, 'instanceOf');
});

afterEach(() => {
  for (const component of components) component.unload();
  components.clear();
  document.body.replaceChildren();
});

function stubActions(parsed: MindDocument, selected: MindDocument['nodes'][number]) {
  return {
    selected: vi.fn<MapActions['selected']>(() => selected),
    visible: vi.fn<MapActions['visible']>(() => parsed.nodes),
    select: vi.fn<MapActions['select']>(),
    fold: vi.fn<MapActions['fold']>(),
    edit: vi.fn<MapActions['edit']>(),
    command: vi.fn<MapActions['command']>(),
    history: vi.fn<MapActions['history']>(),
    attach: vi.fn<MapActions['attach']>(),
    link: vi.fn<MapActions['link']>(),
    dropTarget: vi.fn<MapActions['dropTarget']>((dragged, target, position) => resolveDrop(parsed, dragged, target, position)),
  } satisfies MapActions;
}

function fixture() {
  const parsed = parseMarkdown('# 講座\n\n## First\n\n### Child\n\n## Second\n', 'Course');
  const selected = parsed.nodes.find((node) => node.title === 'First');
  if (!selected) throw new Error('Fixture node missing');
  const actions = stubActions(parsed, selected);
  const canvas = document.createElement('div');
  canvas.tabIndex = 0;
  const node = document.createElement('div');
  node.dataset.nodeId = selected.id;
  const label = document.createElement('span');
  label.textContent = selected.title;
  node.append(label);
  canvas.append(node);
  document.body.append(canvas);
  const events = new MapEvents(canvas, actions);
  components.add(events);
  events.load();
  return { canvas, node, label, selected, actions, events };
}

function click(target: EventTarget, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function key(target: EventTarget, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('MapEvents DOM interactions', () => {
  it('selects the clicked node through nested label elements', () => {
    const { label, selected, actions } = fixture();
    click(label);
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(selected.id, true);
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('selects and folds the owning node when its toggle is clicked', () => {
    const { node, selected, actions } = fixture();
    const toggle = document.createElement('button');
    toggle.className = 'mappy-node-toggle';
    node.append(toggle);
    click(toggle);
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(selected.id, true);
    expect(actions.fold).toHaveBeenCalledExactlyOnceWith(selected.id);
  });

  it.each([{ metaKey: false }, { metaKey: true }, { ctrlKey: true }])(
    'opens internal links without changing selection (%j)',
    (modifiers) => {
      const { node, actions } = fixture();
      const anchor = document.createElement('a');
      anchor.className = 'internal-link';
      anchor.dataset.href = 'Folder/Note#Heading';
      anchor.href = 'Obsidian-resolved-path';
      const child = document.createElement('span');
      anchor.append(child);
      node.append(anchor);
      const event = click(child, modifiers);
      expect(event.defaultPrevented).toBe(true);
      expect(actions.link).toHaveBeenCalledExactlyOnceWith(
        'Folder/Note#Heading', Boolean(modifiers.metaKey || modifiers.ctrlKey),
      );
      expect(actions.select).not.toHaveBeenCalled();
      expect(actions.edit).not.toHaveBeenCalled();
    },
  );

  it('leaves external links to the browser without selecting a node', () => {
    const { node, actions } = fixture();
    const anchor = document.createElement('a');
    // A fragment avoids requesting network navigation in jsdom.
    anchor.href = '#external-link';
    node.append(anchor);
    expect(click(anchor).defaultPrevented).toBe(false);
    expect(actions.link).not.toHaveBeenCalled();
    expect(actions.select).not.toHaveBeenCalled();
  });

  it('ignores Enter while the keyboard event indicates composition', () => {
    const { canvas, actions } = fixture();
    const event = key(canvas, 'Enter', { isComposing: true });
    expect(actions.command).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves the standard IME Process key untouched', () => {
    const { canvas, actions } = fixture();
    expect(key(canvas, 'Process').defaultPrevented).toBe(false);
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('suppresses Enter during a composition session and resumes after compositionend', () => {
    const { canvas, selected, actions } = fixture();
    canvas.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(key(canvas, 'Enter').defaultPrevented).toBe(false);
    expect(actions.command).not.toHaveBeenCalled();
    canvas.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));
    expect(key(canvas, 'Enter').defaultPrevented).toBe(true);
    expect(actions.command).toHaveBeenCalledExactlyOnceWith({ type: 'add-sibling', nodeId: selected.id });
  });

  it.each([['Enter', 'add-sibling'], ['Tab', 'add-child']] as const)(
    '%s adds a %s for the selected node', (input, type) => {
      const { canvas, selected, actions } = fixture();
      const event = key(canvas, input);
      expect(event.defaultPrevented).toBe(true);
      expect(actions.command).toHaveBeenCalledExactlyOnceWith({ type, nodeId: selected.id });
    },
  );

  it.each(['input', 'textarea', 'editable', 'empty-editable'])(
    'does not intercept Enter, Tab, or Undo within %s', (kind) => {
      const { node, actions } = fixture();
      const input = document.createElement(kind === 'input' || kind === 'textarea' ? kind : 'div');
      if (kind.endsWith('editable')) input.setAttribute('contenteditable', kind === 'editable' ? 'true' : '');
      input.tabIndex = 0;
      node.append(input);
      input.focus();
      expect(document.activeElement).toBe(input);
      expect(key(input, 'Enter').defaultPrevented).toBe(false);
      expect(key(input, 'Tab').defaultPrevented).toBe(false);
      expect(key(input, 'z', { metaKey: true }).defaultPrevented).toBe(false);
      expect(actions.command).not.toHaveBeenCalled();
      expect(actions.history).not.toHaveBeenCalled();
    },
  );

  it('lets a focused link receive Enter without creating a node', () => {
    const { node, actions } = fixture();
    const anchor = document.createElement('a');
    anchor.className = 'internal-link';
    anchor.href = '#Note';
    node.append(anchor);
    anchor.focus();
    expect(key(anchor, 'Enter').defaultPrevented).toBe(false);
    expect(actions.command).not.toHaveBeenCalled();
  });

  it.each([
    [{ metaKey: true }, 'undo'],
    [{ ctrlKey: true }, 'undo'],
    [{ metaKey: true, shiftKey: true }, 'redo'],
  ] as const)('routes the platform Undo shortcut (%j) to %s', (modifiers, direction) => {
    const { canvas, actions } = fixture();
    expect(key(canvas, 'z', modifiers).defaultPrevented).toBe(true);
    expect(actions.history).toHaveBeenCalledExactlyOnceWith(direction);
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('handles no-selection keys without changing the document or browser behavior', () => {
    const { canvas, actions } = fixture();
    actions.selected.mockReturnValue(undefined);
    expect(key(canvas, 'Enter').defaultPrevented).toBe(false);
    expect(key(canvas, 'Tab').defaultPrevented).toBe(false);
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('removes DOM listeners on unload and does not duplicate them when loaded again', () => {
    const { canvas, label, selected, actions, events } = fixture();
    events.unload();
    click(label);
    key(canvas, 'Enter');
    key(canvas, 'z', { metaKey: true });
    expect(actions.select).not.toHaveBeenCalled();
    expect(actions.command).not.toHaveBeenCalled();
    expect(actions.history).not.toHaveBeenCalled();
    events.load();
    events.load();
    click(label);
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(selected.id, true);
  });
});

interface FakeTransfer { types: string[]; files: File[]; effectAllowed: string; dropEffect: string; setData: (type: string, value: string) => void }

function transfer(overrides: Partial<FakeTransfer> = {}): FakeTransfer {
  return { types: [], files: [], effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn(), ...overrides };
}

/** jsdom has no DragEvent; a MouseEvent with a dataTransfer property exercises the same handlers. */
function drag(target: EventTarget, type: string, init: MouseEventInit = {}, data: FakeTransfer = transfer()): MouseEvent & { dataTransfer: FakeTransfer } {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  target.dispatchEvent(event);
  return event as MouseEvent & { dataTransfer: FakeTransfer };
}

function dragFixture(source = '# Course\n\n## A\n\n### A1\n\n### A2\n\n### A3\n\n## B\n') {
  const parsed = parseMarkdown(source, 'Course');
  const first = parsed.nodes[0];
  if (!first) throw new Error('Fixture node missing');
  const actions = stubActions(parsed, first);
  const canvas = document.createElement('div');
  const elements = new Map<string, HTMLDivElement>();
  for (const node of parsed.nodes) {
    const element = document.createElement('div');
    element.className = 'mappy-node';
    element.dataset.nodeId = node.id;
    if (node.title === 'Course') element.classList.add('is-root');
    // The Obsidian DOM helpers the drop preview uses, applied per element rather than to prototypes.
    element.addClass = (...classes) => { element.classList.add(...classes); };
    element.removeClass = (...classes) => { element.classList.remove(...classes); };
    element.hasClass = value => element.classList.contains(value);
    // Nodes are 200 × 40 at (0, 100); jsdom does not lay anything out.
    element.getBoundingClientRect = () => ({ x: 0, y: 100, left: 0, top: 100, right: 200, bottom: 140, width: 200, height: 40, toJSON: () => ({}) });
    const label = document.createElement('span');
    label.textContent = node.title;
    element.append(label);
    canvas.append(element);
    elements.set(node.title, element);
  }
  document.body.append(canvas);
  const events = new MapEvents(canvas, actions);
  components.add(events);
  events.load();
  const node = (title: string): HTMLDivElement => {
    const element = elements.get(title);
    if (!element) throw new Error(`Missing node ${title}`);
    return element;
  };
  const id = (title: string): string => {
    const found = parsed.nodes.find((candidate) => candidate.title === title);
    if (!found) throw new Error(`Missing node ${title}`);
    return found.id;
  };
  const indicator = (): { title: string; position: string | undefined }[] => Array.from(canvas.querySelectorAll<HTMLElement>('.is-drop-target'))
    .map((element) => ({ title: element.textContent ?? '', position: element.dataset.drop }));
  return { parsed, canvas, actions, node, id, indicator };
}

describe('MapEvents drag and drop reordering', () => {
  it('previews before/after lines on the edges of a sibling and moves there on drop', () => {
    const { actions, node, id, indicator } = dragFixture();
    const start = drag(node('A3'), 'dragstart');
    expect(start.dataTransfer.setData).toHaveBeenCalledWith('application/x-mappy-node', id('A3'));
    expect(actions.select).toHaveBeenCalledWith(id('A3'));
    const upper = drag(node('A1'), 'dragover', { clientX: 50, clientY: 105 });
    expect(upper.defaultPrevented).toBe(true);
    expect(upper.dataTransfer.dropEffect).toBe('move');
    expect(indicator()).toEqual([{ title: 'A1', position: 'before' }]);
    const lower = drag(node('A1'), 'dragover', { clientX: 50, clientY: 135 });
    expect(lower.defaultPrevented).toBe(true);
    expect(indicator()).toEqual([{ title: 'A1', position: 'after' }]);
    const drop = drag(node('A1'), 'drop', { clientX: 50, clientY: 135 });
    expect(drop.defaultPrevented).toBe(true);
    expect(actions.command).toHaveBeenCalledExactlyOnceWith({ type: 'move', nodeId: id('A3'), parentId: id('A'), index: 1 });
    expect(indicator()).toEqual([]);
  });

  it('uses the middle of a node to append the dragged branch as its last child', () => {
    const { actions, node, id, indicator } = dragFixture();
    drag(node('A3'), 'dragstart');
    drag(node('A1'), 'dragover', { clientX: 50, clientY: 120 });
    expect(indicator()).toEqual([{ title: 'A1', position: 'inside' }]);
    drag(node('A1'), 'drop', { clientX: 50, clientY: 120 });
    expect(actions.command).toHaveBeenCalledExactlyOnceWith({ type: 'move', nodeId: id('A3'), parentId: id('A1'), index: 0 });
  });

  it('refuses the dragged node itself and its descendants without a preview', () => {
    const { actions, node, indicator } = dragFixture();
    drag(node('A'), 'dragstart');
    for (const [title, clientY] of [['A1', 105], ['A1', 120], ['A', 105], ['A', 120]] as const) {
      const over = drag(node(title), 'dragover', { clientX: 50, clientY });
      expect(over.defaultPrevented).toBe(false);
      expect(over.dataTransfer.dropEffect).toBe('none');
      expect(indicator()).toEqual([]);
    }
    drag(node('A1'), 'drop', { clientX: 50, clientY: 120 });
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('clears a stale preview when the pointer leaves the node, the canvas, or the drag ends', () => {
    const { canvas, node, indicator } = dragFixture();
    drag(node('A3'), 'dragstart');
    drag(node('A1'), 'dragover', { clientX: 50, clientY: 105 });
    expect(indicator()).toHaveLength(1);
    drag(canvas, 'dragover', { clientX: 400, clientY: 400 });
    expect(indicator()).toEqual([]);
    drag(node('B'), 'dragover', { clientX: 50, clientY: 120 });
    expect(indicator()).toEqual([{ title: 'B', position: 'inside' }]);
    const leave = new MouseEvent('dragleave', { bubbles: true, relatedTarget: document.body });
    canvas.dispatchEvent(leave);
    expect(indicator()).toEqual([]);
    drag(node('B'), 'dragover', { clientX: 50, clientY: 120 });
    drag(canvas, 'dragend');
    expect(indicator()).toEqual([]);
    const over = drag(node('A1'), 'dragover', { clientX: 50, clientY: 105 });
    expect(over.defaultPrevented).toBe(false);
  });

  it('only offers the child position on the visual root', () => {
    const { actions, node, id, indicator } = dragFixture();
    drag(node('B'), 'dragstart');
    drag(node('Course'), 'dragover', { clientX: 50, clientY: 101 });
    expect(indicator()).toEqual([{ title: 'Course', position: 'inside' }]);
    drag(node('Course'), 'drop', { clientX: 50, clientY: 101 });
    expect(actions.command).toHaveBeenCalledExactlyOnceWith({ type: 'move', nodeId: id('B'), parentId: id('Course'), index: 1 });
  });

  it('reads left and right edges for timeline stages that sit on the horizontal axis', () => {
    const { actions, node, id, indicator } = dragFixture();
    for (const title of ['A', 'B']) node(title).classList.add('is-timeline', 'is-stage');
    drag(node('B'), 'dragstart');
    drag(node('A'), 'dragover', { clientX: 10, clientY: 101 });
    expect(indicator()).toEqual([{ title: 'A', position: 'before' }]);
    drag(node('A'), 'dragover', { clientX: 190, clientY: 101 });
    expect(indicator()).toEqual([{ title: 'A', position: 'after' }]);
    drag(node('A'), 'dragover', { clientX: 100, clientY: 101 });
    expect(indicator()).toEqual([{ title: 'A', position: 'inside' }]);
    drag(node('A'), 'dragover', { clientX: 10, clientY: 101 });
    drag(node('A'), 'drop', { clientX: 10, clientY: 101 });
    expect(actions.command).toHaveBeenCalledExactlyOnceWith({ type: 'move', nodeId: id('B'), parentId: id('Course'), index: 0 });
  });

  it('keeps image file drops as attachments to the hovered node', () => {
    const { actions, node, id, indicator } = dragFixture();
    const image = new File(['png'], 'figure.png', { type: 'image/png' });
    const over = drag(node('A1'), 'dragover', { clientX: 50, clientY: 105 }, transfer({ types: ['Files'] }));
    expect(over.defaultPrevented).toBe(true);
    expect(indicator()).toEqual([{ title: 'A1', position: 'inside' }]);
    const drop = drag(node('A1'), 'drop', { clientX: 50, clientY: 105 }, transfer({ types: ['Files'], files: [image] }));
    expect(drop.defaultPrevented).toBe(true);
    expect(actions.select).toHaveBeenCalledWith(id('A1'));
    expect(actions.attach).toHaveBeenCalledExactlyOnceWith(image);
    expect(actions.command).not.toHaveBeenCalled();
    expect(indicator()).toEqual([]);
  });

  it('ignores foreign drags that carry neither a map node nor files', () => {
    const { actions, node, indicator } = dragFixture();
    const over = drag(node('A1'), 'dragover', { clientX: 50, clientY: 105 }, transfer({ types: ['text/plain'] }));
    expect(over.defaultPrevented).toBe(false);
    expect(indicator()).toEqual([]);
    drag(node('A1'), 'drop', { clientX: 50, clientY: 105 }, transfer({ types: ['text/plain'] }));
    expect(actions.command).not.toHaveBeenCalled();
    expect(actions.attach).not.toHaveBeenCalled();
  });
});
