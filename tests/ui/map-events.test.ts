// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseMarkdown } from '../../src/core/markdown';
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

function fixture() {
  const parsed = parseMarkdown('# 講座\n\n## First\n\n### Child\n\n## Second\n', 'Course');
  const selected = parsed.nodes.find((node) => node.title === 'First');
  if (!selected) throw new Error('Fixture node missing');
  const actions = {
    selected: vi.fn<MapActions['selected']>(() => selected),
    visible: vi.fn<MapActions['visible']>(() => parsed.nodes),
    select: vi.fn<MapActions['select']>(),
    fold: vi.fn<MapActions['fold']>(),
    edit: vi.fn<MapActions['edit']>(),
    command: vi.fn<MapActions['command']>(),
    history: vi.fn<MapActions['history']>(),
    attach: vi.fn<MapActions['attach']>(),
    link: vi.fn<MapActions['link']>(),
  } satisfies MapActions;
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
