// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';
import { MapEvents, mapClick, nodeOf, type MapActions } from '../../src/ui/map-events';
import { keyAt } from './keys';

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
    addTopic: vi.fn<MapActions['addTopic']>(),
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

  it('double-clicks a node into editing and empty canvas into a new topic at the canvas-relative point', () => {
    const { canvas, label, selected, actions } = fixture();
    canvas.getBoundingClientRect = () => ({ x: 20, y: 30, left: 20, top: 30, width: 800, height: 600, right: 820, bottom: 630, toJSON: () => ({}) });
    const dblclick = (target: EventTarget, clientX: number, clientY: number): MouseEvent => {
      const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY });
      target.dispatchEvent(event);
      return event;
    };
    dblclick(label, 100, 100);
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(selected.id);
    expect(actions.edit).toHaveBeenCalledOnce();
    expect(actions.addTopic).not.toHaveBeenCalled();
    const onCanvas = dblclick(canvas, 320, 230);
    expect(actions.addTopic).toHaveBeenCalledExactlyOnceWith({ x: 300, y: 200 });
    expect(onCanvas.defaultPrevented).toBe(true);
    expect(actions.edit).toHaveBeenCalledOnce();
    // Floating controls and text inputs keep their own double-click.
    const tools = document.createElement('div');
    tools.className = 'mappy-floating';
    const button = document.createElement('button');
    tools.append(button);
    canvas.append(tools);
    dblclick(button, 400, 400);
    const input = document.createElement('textarea');
    canvas.append(input);
    dblclick(input, 400, 400);
    expect(actions.addTopic).toHaveBeenCalledOnce();
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

  it('answers for the node that holds an embedded map, never for the nodes drawn inside it (§5 M12)', () => {
    const { canvas, node, selected, actions } = fixture();
    // The frame a `![[map]]` node draws: a canvas of its own with nodes, toggles and links of the embedded map.
    const frame = document.createElement('div');
    frame.className = 'mappy-embed mappy-view';
    const innerCanvas = document.createElement('div');
    innerCanvas.className = 'mappy-canvas';
    const inner = document.createElement('div');
    inner.className = 'mappy-node';
    inner.dataset.nodeId = 'inner-1';
    const innerLabel = document.createElement('span');
    inner.append(innerLabel);
    const innerToggle = document.createElement('button');
    innerToggle.className = 'mappy-node-toggle';
    inner.append(innerToggle);
    innerCanvas.append(inner);
    frame.append(innerCanvas);
    node.append(frame);
    expect(nodeOf(canvas, innerLabel)).toBe(node);
    expect(nodeOf(canvas, innerToggle)).toBe(node);
    expect(nodeOf(innerCanvas, innerLabel)).toBe(inner);
    expect(nodeOf(canvas, canvas)).toBeNull();
    expect(nodeOf(canvas, document.body)).toBeNull();
    // What each canvas reads from the same click, taken as the event passes the inner canvas.
    const readings: unknown[] = [];
    innerCanvas.addEventListener('click', event => { readings.push(mapClick(event, canvas), mapClick(event, innerCanvas)); });
    click(innerToggle);
    // The inner toggle is the embedded map's; seen from the outer canvas it is a plain click on the holding node.
    expect(readings).toEqual([{ nodeId: selected.id, toggle: false }, { nodeId: 'inner-1', toggle: true }]);
    readings.length = 0;
    actions.select.mockClear();
    actions.fold.mockClear();
    click(innerLabel);
    expect(readings).toEqual([{ nodeId: selected.id, toggle: false }, { nodeId: 'inner-1', toggle: false }]);
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(selected.id, true);
    expect(actions.fold).not.toHaveBeenCalled();
    innerLabel.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    expect(actions.edit).toHaveBeenCalledOnce();
    expect(actions.select).toHaveBeenLastCalledWith(selected.id);
    expect(actions.addTopic).not.toHaveBeenCalled();
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

  it('does not act on a key something else already consumed', () => {
    const { canvas, node, actions } = fixture();
    // Obsidian's keymap consumes a key at the window's capture phase; a listener there stands in for it.
    const consume = (event: KeyboardEvent): void => { if (event.key === 'F2') event.preventDefault(); };
    window.addEventListener('keydown', consume, true);
    try {
      expect(key(node, 'F2').defaultPrevented).toBe(true);
      expect(actions.edit).not.toHaveBeenCalled();
      expect(key(canvas, 'Enter').defaultPrevented).toBe(true);
      expect(actions.command).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('keydown', consume, true); }
  });

  it('leaves Shift chords alone: Shift+Tab keeps moving the focus, Shift+Enter and Shift+Backspace add and delete nothing', () => {
    const { canvas, node, actions } = fixture();
    for (const value of ['Tab', 'Enter', 'Backspace', 'Delete', 'F2', ' ']) {
      expect(key(node, value, { shiftKey: true }).defaultPrevented).toBe(false);
    }
    expect(key(canvas, 'ArrowUp', { altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(actions.command).not.toHaveBeenCalled();
    expect(actions.edit).not.toHaveBeenCalled();
    expect(actions.fold).not.toHaveBeenCalled();
    // The same keys without Shift are the map's.
    expect(key(node, 'Tab').defaultPrevented).toBe(true);
    expect(actions.command).toHaveBeenCalledOnce();
  });

  describe('as the view scope handler (Obsidian consults it before its own hotkeys)', () => {
    it('takes F2 on a node inside the canvas: edits, prevents the default and reports it as consumed', () => {
      const { node, actions, events } = fixture();
      const event = keyAt(node, 'F2');
      expect(events.hotkey(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(actions.edit).toHaveBeenCalledOnce();
    });

    it('does not act outside the canvas, inside the inline editor, during composition or without a selection', () => {
      const { canvas, node, actions, events } = fixture();
      const outside = document.createElement('button');
      document.body.append(outside);
      expect(events.hotkey(keyAt(outside, 'F2'))).toBeUndefined();
      expect(events.hotkey(keyAt(document.body, 'F2'))).toBeUndefined();
      const input = document.createElement('textarea');
      node.append(input);
      expect(events.hotkey(keyAt(input, 'F2'))).toBeUndefined();
      const composing = keyAt(node, 'F2', { isComposing: true });
      expect(events.hotkey(composing)).toBeUndefined();
      expect(composing.defaultPrevented).toBe(false);
      actions.selected.mockReturnValue(undefined);
      const unselected = keyAt(canvas, 'F2');
      expect(events.hotkey(unselected)).toBeUndefined();
      expect(unselected.defaultPrevented).toBe(false);
      expect(actions.edit).not.toHaveBeenCalled();
    });

    it('edits once when the keymap consumes the key before the canvas listener sees it', () => {
      const { node, actions, events } = fixture();
      // What Obsidian's Keymap does with a `false` from the active view's scope: preventDefault and stopPropagation.
      const keymap = (event: KeyboardEvent): void => {
        if (events.hotkey(event) === false) { event.preventDefault(); event.stopPropagation(); }
      };
      window.addEventListener('keydown', keymap, true);
      try {
        expect(key(node, 'F2').defaultPrevented).toBe(true);
        expect(actions.edit).toHaveBeenCalledOnce();
      } finally { window.removeEventListener('keydown', keymap, true); }
      // Without the keymap (the browser page, jsdom) the canvas listener still takes F2.
      expect(key(node, 'F2').defaultPrevented).toBe(true);
      expect(actions.edit).toHaveBeenCalledTimes(2);
    });
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

function dragFixture(source = '# Course\n\n## A\n\n### A1\n\n### A2\n\n## B\n') {
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
    element.addClass = (...classes) => { element.classList.add(...classes); };
    element.removeClass = (...classes) => { element.classList.remove(...classes); };
    element.hasClass = value => element.classList.contains(value);
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
  const highlighted = (): string[] => Array.from(canvas.querySelectorAll<HTMLElement>('.is-drop-target')).map((element) => element.textContent ?? '');
  return { canvas, actions, node, id, highlighted };
}

describe('MapEvents file drops next to pointer dragging', () => {
  it('prevents native drags from starting on a node so the pointer drag owns the gesture', () => {
    const { node } = dragFixture();
    expect(drag(node('A1').firstElementChild ?? node('A1'), 'dragstart').defaultPrevented).toBe(true);
  });

  it('highlights the hovered node for a file drag and attaches a dropped image to it', () => {
    const { actions, node, id, highlighted } = dragFixture();
    const image = new File(['png'], 'figure.png', { type: 'image/png' });
    const over = drag(node('A1'), 'dragover', { clientX: 50, clientY: 105 }, transfer({ types: ['Files'] }));
    expect(over.defaultPrevented).toBe(true);
    expect(highlighted()).toEqual(['A1']);
    drag(node('A2'), 'dragover', { clientX: 50, clientY: 105 }, transfer({ types: ['Files'] }));
    expect(highlighted()).toEqual(['A2']);
    const drop = drag(node('A2'), 'drop', { clientX: 50, clientY: 105 }, transfer({ types: ['Files'], files: [image] }));
    expect(drop.defaultPrevented).toBe(true);
    expect(actions.select).toHaveBeenCalledWith(id('A2'));
    expect(actions.attach).toHaveBeenCalledExactlyOnceWith(image);
    expect(actions.command).not.toHaveBeenCalled();
    expect(highlighted()).toEqual([]);
  });

  it('clears the highlight when the file drag leaves the canvas or ends', () => {
    const { canvas, node, highlighted } = dragFixture();
    drag(node('A1'), 'dragover', {}, transfer({ types: ['Files'] }));
    expect(highlighted()).toEqual(['A1']);
    canvas.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: document.body }));
    expect(highlighted()).toEqual([]);
    drag(node('A1'), 'dragover', {}, transfer({ types: ['Files'] }));
    drag(canvas, 'dragend');
    expect(highlighted()).toEqual([]);
  });

  it('highlights and attaches to the node holding an embedded map when the file is dragged over the map inside it', () => {
    const { actions, node, id, highlighted } = dragFixture();
    const frame = document.createElement('div');
    frame.className = 'mappy-embed mappy-view';
    const inner = document.createElement('div');
    inner.className = 'mappy-node';
    inner.dataset.nodeId = 'inner-1';
    inner.textContent = 'inner';
    frame.append(inner);
    node('A1').append(frame);
    const image = new File(['png'], 'figure.png', { type: 'image/png' });
    drag(inner, 'dragover', { clientX: 50, clientY: 105 }, transfer({ types: ['Files'] }));
    expect(highlighted()).toEqual(['A1inner']);
    expect(inner.classList.contains('is-drop-target')).toBe(false);
    drag(inner, 'drop', { clientX: 50, clientY: 105 }, transfer({ types: ['Files'], files: [image] }));
    expect(actions.select).toHaveBeenCalledWith(id('A1'));
    expect(actions.attach).toHaveBeenCalledExactlyOnceWith(image);
  });

  it('ignores drags that carry neither files nor an image', () => {
    const { actions, node, highlighted } = dragFixture();
    const over = drag(node('A1'), 'dragover', {}, transfer({ types: ['text/plain'] }));
    expect(over.defaultPrevented).toBe(false);
    expect(highlighted()).toEqual([]);
    const text = new File(['hi'], 'note.txt', { type: 'text/plain' });
    expect(drag(node('A1'), 'drop', {}, transfer({ types: ['Files'], files: [text] })).defaultPrevented).toBe(false);
    expect(actions.attach).not.toHaveBeenCalled();
    expect(actions.command).not.toHaveBeenCalled();
  });
});
