// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDrop } from '../../src/core/commands';
import { parseMarkdown } from '../../src/core/markdown';
import { PLACEHOLDER_ID } from '../../src/layout/drop-preview';
import { NodeDrag, type NodeDragActions } from '../../src/ui/node-drag';

const originalTargetNode = Object.getOwnPropertyDescriptor(UIEvent.prototype, 'targetNode');
const originalInstanceOf = Object.getOwnPropertyDescriptor(Node.prototype, 'instanceOf');
const components = new Set<NodeDrag>();

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

interface Rect { left: number; top: number; width: number; height: number }

function rectOf(rect: Rect): DOMRect {
  return {
    x: rect.left, y: rect.top, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}),
  };
}

/** Obsidian's small DOM surface, applied per element rather than to prototypes. */
function obsidianDom<T extends HTMLElement>(element: T): T {
  element.addClass = (...classes) => { element.classList.add(...classes); };
  element.removeClass = (...classes) => { element.classList.remove(...classes); };
  element.hasClass = value => element.classList.contains(value);
  return element;
}

/** Nodes are stacked 40px tall with a 20px gap in a column at x 100–300; the canvas is 0–800 × 0–600. */
function fixture(source = '# Course\n\n## A\n\n### A1\n\n### A2\n\n### A3\n\n## B\n', free: readonly string[] = []) {
  const parsed = parseMarkdown(source, 'Course');
  const freeIds = new Set(parsed.nodes.filter((node) => free.includes(node.title)).map((node) => node.id));
  const canvas = obsidianDom(document.createElement('div'));
  canvas.getBoundingClientRect = () => rectOf({ left: 0, top: 0, width: 800, height: 600 });
  const capture = { set: vi.fn(), release: vi.fn() };
  canvas.setPointerCapture = capture.set;
  canvas.releasePointerCapture = capture.release;
  canvas.hasPointerCapture = () => true;
  const rects = new Map<HTMLElement, Rect>();
  const elements = new Map<string, HTMLElement>();
  parsed.nodes.forEach((node, index) => {
    const element = obsidianDom(document.createElement('div'));
    element.className = 'mappy-node';
    element.dataset.nodeId = node.id;
    if (node.title === 'Course') element.classList.add('is-root');
    const rect = { left: 100, top: 100 + index * 60, width: 200, height: 40 };
    rects.set(element, rect);
    element.getBoundingClientRect = () => rectOf(rects.get(element) ?? rect);
    Object.defineProperty(element, 'offsetWidth', { value: 200 });
    Object.defineProperty(element, 'offsetHeight', { value: 40 });
    const label = document.createElement('span');
    label.textContent = node.title;
    element.append(label);
    canvas.append(element);
    elements.set(node.title, element);
  });
  const placeholder = document.createElement('div');
  placeholder.dataset.dropPlaceholder = '';
  placeholder.hidden = true;
  canvas.append(placeholder);
  let placeholderRect: Rect | null = null;
  // jsdom has no hit testing; resolve points against the mocked rectangles instead.
  Object.defineProperty(canvas, 'doc', { value: {
    elementFromPoint(x: number, y: number): Element | null {
      const within = (rect: Rect): boolean => x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
      if (placeholderRect && within(placeholderRect)) return placeholder;
      for (const [element, rect] of rects) if (within(rect)) return element.firstElementChild ?? element;
      return canvas;
    },
  } });
  document.body.append(canvas);
  const actions = {
    select: vi.fn<NodeDragActions['select']>(),
    free: vi.fn<NodeDragActions['free']>(id => freeIds.has(id)),
    dropTarget: vi.fn<NodeDragActions['dropTarget']>((dragged, target, position) => resolveDrop(parsed, dragged, target, position)),
    preview: vi.fn<NodeDragActions['preview']>(),
    command: vi.fn<NodeDragActions['command']>(),
    shift: vi.fn<NodeDragActions['shift']>(),
    place: vi.fn<NodeDragActions['place']>(),
  } satisfies NodeDragActions;
  const drag = new NodeDrag(canvas, actions);
  components.add(drag);
  drag.load();
  const node = (title: string): HTMLElement => {
    const element = elements.get(title);
    if (!element) throw new Error(`Missing node ${title}`);
    return element;
  };
  const id = (title: string): string => {
    const found = parsed.nodes.find((candidate) => candidate.title === title);
    if (!found) throw new Error(`Missing node ${title}`);
    return found.id;
  };
  const pointer = (type: string, target: EventTarget, x: number, y: number, init: PointerEventInit = {}): PointerEvent => {
    const event = new PointerEvent(type, { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const center = (title: string): [number, number] => {
    const rect = rects.get(node(title));
    if (!rect) throw new Error(`Missing rect ${title}`);
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  };
  /** Press on a node and move far enough to start a drag. */
  const begin = (title: string): void => {
    const [x, y] = center(title);
    pointer('pointerdown', node(title).firstElementChild ?? node(title), x, y);
    pointer('pointermove', canvas, x + 6, y);
  };
  const ghost = (): HTMLElement | null => canvas.querySelector('.mappy-drag-ghost');
  const showPlaceholder = (rect: Rect | null): void => { placeholderRect = rect; placeholder.hidden = !rect; };
  return { parsed, canvas, actions, node, id, pointer, center, begin, ghost, rects, showPlaceholder, placeholder, capture };
}

describe('NodeDrag pointer dragging', () => {
  it('starts only after the pointer travels past the threshold, then shows a ghost and fades the source', () => {
    const { canvas, actions, node, id, pointer, center, ghost, capture } = fixture();
    const [x, y] = center('A3');
    pointer('pointerdown', node('A3'), x, y);
    pointer('pointermove', canvas, x + 2, y + 2);
    expect(ghost()).toBeNull();
    expect(actions.select).not.toHaveBeenCalled();
    pointer('pointermove', canvas, x + 5, y);
    const clone = ghost();
    expect(clone?.textContent).toBe('A3');
    expect(clone?.hasAttribute('data-node-id')).toBe(false);
    expect(clone?.style.transform).toContain('translate(');
    expect(node('A3').classList.contains('is-drag-source')).toBe(true);
    expect(canvas.classList.contains('is-dragging-node')).toBe(true);
    expect(capture.set).toHaveBeenCalledWith(1);
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(id('A3'));
    pointer('pointerup', canvas, x + 5, y);
    expect(ghost()).toBeNull();
    expect(node('A3').classList.contains('is-drag-source')).toBe(false);
    expect(canvas.classList.contains('is-dragging-node')).toBe(false);
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('keeps the ghost under the grab point and scaled like the zoomed node', () => {
    const { canvas, node, pointer, ghost, rects } = fixture();
    // Zoomed to 150%: the 200 × 40 node measures 300 × 60 on screen.
    rects.set(node('A3'), { left: 100, top: 340, width: 300, height: 60 });
    pointer('pointerdown', node('A3'), 130, 350);
    pointer('pointermove', canvas, 140, 350);
    pointer('pointermove', canvas, 400, 500);
    expect(ghost()?.style.transform).toBe('translate(370px, 490px) scale(1.5)');
    expect(ghost()?.style.width).toBe('200px');
  });

  it('previews sibling slots on node edges and the child slot in the middle, then drops what was previewed', () => {
    const { canvas, actions, id, pointer, begin, capture } = fixture();
    begin('A3');
    pointer('pointermove', canvas, 200, 223);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('A3'), parentId: id('A'), index: 0 });
    pointer('pointermove', canvas, 200, 240);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('A3'), parentId: id('A1'), index: 0 });
    pointer('pointermove', canvas, 200, 257);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('A3'), parentId: id('A'), index: 1 });
    pointer('pointerup', canvas, 200, 257);
    expect(actions.preview).toHaveBeenLastCalledWith(null);
    expect(actions.command).toHaveBeenCalledExactlyOnceWith({ type: 'move', nodeId: id('A3'), parentId: id('A'), index: 1 });
    expect(capture.release).toHaveBeenCalledWith(1);
  });

  it('changes zones on the targeted node at once, with a dead band so a resting pointer does not flicker', () => {
    const { canvas, actions, id, pointer, begin } = fixture();
    begin('B');
    pointer('pointermove', canvas, 200, 223);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 0 });
    pointer('pointermove', canvas, 200, 305);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A2'), index: 0 });
    const calls = actions.preview.mock.calls.length;
    // A2 spans y 280–320; leaving "inside" needs 78% (311.2) instead of the plain 70% (308).
    pointer('pointermove', canvas, 200, 310);
    pointer('pointermove', canvas, 201, 311);
    expect(actions.preview.mock.calls.length).toBe(calls);
    pointer('pointermove', canvas, 200, 313);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 2 });
    // Coming back needs 62% (304.8) rather than 70%, so the boundary always sits away from the pointer.
    pointer('pointermove', canvas, 200, 306);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 2 });
    pointer('pointermove', canvas, 200, 303);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A2'), index: 0 });
  });

  it('ignores relayout under a still pointer: another node needs a deliberate move to take over', () => {
    const { canvas, actions, id, pointer, begin, node, rects } = fixture();
    // Put A3 right below A2 (touching), so a tiny drift after a switch lands on it, as a relayout would.
    rects.set(node('A3'), { left: 100, top: 318, width: 200, height: 40 });
    begin('B');
    pointer('pointermove', canvas, 200, 316);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 2 });
    const calls = actions.preview.mock.calls.length;
    // Switched at (200, 316); 5px later the pointer is on A3, which is not deliberate travel yet.
    pointer('pointermove', canvas, 200, 321);
    expect(actions.preview.mock.calls.length).toBe(calls);
    pointer('pointermove', canvas, 200, 338);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A3'), index: 0 });
  });

  it('keeps the current slot over the placeholder, the source, and empty canvas', () => {
    const { canvas, actions, id, pointer, begin, showPlaceholder } = fixture();
    begin('B');
    pointer('pointermove', canvas, 200, 223);
    const calls = actions.preview.mock.calls.length;
    showPlaceholder({ left: 100, top: 130, width: 200, height: 40 });
    pointer('pointermove', canvas, 200, 150);
    pointer('pointermove', canvas, 600, 500);
    pointer('pointermove', canvas, 200, 400);
    expect(actions.preview.mock.calls.length).toBe(calls);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 0 });
  });

  it('clears the preview over a descendant and when the pointer leaves the canvas, so releasing there drops nothing', () => {
    const { canvas, actions, id, pointer, begin } = fixture();
    begin('A');
    pointer('pointermove', canvas, 200, 420);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('A'), parentId: id('B'), index: 0 });
    pointer('pointermove', canvas, 200, 240);
    expect(actions.preview).toHaveBeenLastCalledWith(null);
    pointer('pointermove', canvas, 200, 420);
    pointer('pointermove', canvas, 900, 420);
    expect(actions.preview).toHaveBeenLastCalledWith(null);
    pointer('pointerup', canvas, 900, 420);
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('cancels with Escape or pointercancel without moving anything', () => {
    const { canvas, actions, pointer, begin, ghost } = fixture();
    begin('A3');
    pointer('pointermove', canvas, 200, 223);
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ghost()).toBeNull();
    expect(actions.preview).toHaveBeenLastCalledWith(null);
    pointer('pointerup', canvas, 200, 223);
    expect(actions.command).not.toHaveBeenCalled();
    begin('A3');
    pointer('pointermove', canvas, 200, 223);
    pointer('pointercancel', canvas, 200, 223);
    expect(ghost()).toBeNull();
    expect(actions.command).not.toHaveBeenCalled();
  });

  it('only offers the child slot on the root and left/right slots on timeline stages', () => {
    const { canvas, actions, node, id, pointer, begin } = fixture();
    begin('B');
    pointer('pointermove', canvas, 200, 101);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('Course'), index: 1 });
    pointer('pointerup', canvas, 200, 101);
    node('A').classList.add('is-timeline', 'is-stage');
    begin('B');
    pointer('pointermove', canvas, 110, 165);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('Course'), index: 0 });
    pointer('pointermove', canvas, 290, 165);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('Course'), index: 1 });
  });

  it('starts from links and images but not from controls or non-primary buttons, and cleans up on unload', () => {
    const { canvas, actions, node, pointer, ghost, begin } = fixture();
    for (const tag of ['a', 'img'] as const) {
      const child = document.createElement(tag);
      node('A2').append(child);
      pointer('pointerdown', child, 200, 300);
      pointer('pointermove', canvas, 240, 300);
      expect(ghost()).not.toBeNull();
      pointer('pointercancel', canvas, 240, 300);
      expect(ghost()).toBeNull();
      child.remove();
    }
    actions.select.mockClear();
    for (const tag of ['button', 'textarea'] as const) {
      const child = document.createElement(tag);
      node('A2').append(child);
      pointer('pointerdown', child, 200, 300);
      pointer('pointermove', canvas, 240, 300);
      expect(ghost()).toBeNull();
      child.remove();
    }
    pointer('pointerdown', node('A2'), 200, 300, { button: 2 });
    pointer('pointermove', canvas, 240, 300);
    expect(ghost()).toBeNull();
    expect(actions.select).not.toHaveBeenCalled();
    begin('A3');
    expect(ghost()).not.toBeNull();
    for (const component of components) component.unload();
    expect(ghost()).toBeNull();
    expect(canvas.classList.contains('is-dragging-node')).toBe(false);
    expect(actions.preview).toHaveBeenLastCalledWith(null);
    expect(actions.command).not.toHaveBeenCalled();
  });

  describe('free nodes (free-topic roots)', () => {
    const TOPICS = '## Body\n- Child\n\n## Topic\n- Under\n';

    it('moves its own tree: no ghost, no slot preview, live offsets, and a release inside the canvas places it', () => {
      const { canvas, actions, node, id, pointer, center, ghost } = fixture(TOPICS, ['Topic']);
      const [x, y] = center('Topic');
      pointer('pointerdown', node('Topic'), x, y);
      pointer('pointermove', canvas, x + 2, y);
      expect(actions.shift).not.toHaveBeenCalled();
      pointer('pointermove', canvas, x + 10, y + 4);
      expect(ghost()).toBeNull();
      expect(node('Topic').classList.contains('is-drag-moving')).toBe(true);
      expect(node('Topic').classList.contains('is-drag-source')).toBe(false);
      expect(canvas.classList.contains('is-dragging-node')).toBe(true);
      expect(actions.select).toHaveBeenCalledExactlyOnceWith(id('Topic'));
      expect(actions.shift).toHaveBeenLastCalledWith(id('Topic'), { x: 10, y: 4 });
      // Over another node nothing is previewed: a free node lands at a position, not in a slot.
      const [bx, by] = center('Child');
      pointer('pointermove', canvas, bx, by);
      expect(actions.shift).toHaveBeenLastCalledWith(id('Topic'), { x: bx - x, y: by - y });
      expect(actions.dropTarget).not.toHaveBeenCalled();
      expect(actions.preview).not.toHaveBeenCalled();
      pointer('pointerup', canvas, x + 120, y - 60);
      expect(actions.place).toHaveBeenCalledExactlyOnceWith(id('Topic'), { x: 120, y: -60 });
      expect(actions.command).not.toHaveBeenCalled();
      expect(node('Topic').classList.contains('is-drag-moving')).toBe(false);
      expect(canvas.classList.contains('is-dragging-node')).toBe(false);
      // The view owns the end of a placed drag; only a cancelled one is put back through shift(null).
      expect(actions.shift).not.toHaveBeenCalledWith(id('Topic'), null);
    });

    it('puts the tree back on Escape, pointercancel, or a release outside the canvas', () => {
      for (const cancel of ['escape', 'pointercancel', 'outside'] as const) {
        const { canvas, actions, node, id, pointer, center } = fixture(TOPICS, ['Topic']);
        const [x, y] = center('Topic');
        pointer('pointerdown', node('Topic'), x, y);
        pointer('pointermove', canvas, x + 30, y + 30);
        expect(actions.shift).toHaveBeenLastCalledWith(id('Topic'), { x: 30, y: 30 });
        if (cancel === 'escape') canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        else if (cancel === 'pointercancel') pointer('pointercancel', canvas, x + 30, y + 30);
        else { pointer('pointermove', canvas, 900, 700); pointer('pointerup', canvas, 900, 700); }
        expect(actions.shift).toHaveBeenLastCalledWith(id('Topic'), null);
        expect(actions.place).not.toHaveBeenCalled();
        expect(node('Topic').classList.contains('is-drag-moving')).toBe(false);
        document.body.replaceChildren();
      }
    });

    it('leaves clicks alone and keeps tree drags for the body and its descendants', () => {
      const { canvas, actions, node, pointer, center, ghost } = fixture(TOPICS, ['Topic']);
      const [x, y] = center('Topic');
      pointer('pointerdown', node('Topic'), x, y);
      pointer('pointerup', canvas, x + 1, y);
      expect(actions.shift).not.toHaveBeenCalled();
      expect(actions.place).not.toHaveBeenCalled();
      const [cx, cy] = center('Child');
      pointer('pointerdown', node('Child'), cx, cy);
      pointer('pointermove', canvas, cx + 8, cy);
      expect(ghost()).not.toBeNull();
      expect(actions.shift).not.toHaveBeenCalled();
      pointer('pointerup', canvas, cx + 8, cy);
    });
  });

  it('exposes the placeholder id the view must mark on its element', () => {
    expect(PLACEHOLDER_ID).toBe('mappy-drop-placeholder');
  });
});
