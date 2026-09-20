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
function fixture(source = '# Course\n\n## A\n\n### A1\n\n### A2\n\n### A3\n\n## B\n', free: readonly string[] = [], readOnly: readonly string[] = []) {
  const parsed = parseMarkdown(source, 'Course');
  const freeIds = new Set(parsed.nodes.filter((node) => free.includes(node.title)).map((node) => node.id));
  const readOnlyIds = new Set(parsed.nodes.filter((node) => readOnly.includes(node.title)).map((node) => node.id));
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
    readOnly: vi.fn<NodeDragActions['readOnly']>(id => readOnlyIds.has(id)),
    free: vi.fn<NodeDragActions['free']>(id => freeIds.has(id)),
    dropTarget: vi.fn<NodeDragActions['dropTarget']>((dragged, target, position) => resolveDrop(parsed, dragged, target, position)),
    preview: vi.fn<NodeDragActions['preview']>(),
    command: vi.fn<NodeDragActions['command']>(),
    shift: vi.fn<NodeDragActions['shift']>(),
    place: vi.fn<NodeDragActions['place']>(),
    detach: vi.fn<NodeDragActions['detach']>(),
    snap: vi.fn<NodeDragActions['snap']>(() => null),
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

  it('keeps the current slot over the placeholder, the source, and nearby empty canvas', () => {
    const { canvas, actions, id, pointer, begin, showPlaceholder } = fixture();
    begin('B');
    pointer('pointermove', canvas, 200, 223);
    const calls = actions.preview.mock.calls.length;
    showPlaceholder({ left: 100, top: 130, width: 200, height: 40 });
    pointer('pointermove', canvas, 200, 150);
    // 30 px right of A1's box: empty canvas, but close enough to keep the slot.
    pointer('pointermove', canvas, 330, 240);
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

  it('uses left/right slots on every hierarchy node, stage or not', () => {
    const { canvas, actions, node, id, pointer, begin } = fixture();
    for (const title of ['A', 'A2']) node(title).classList.add('is-hierarchy');
    begin('B');
    // Left edge of a hierarchy stage: before it among the root's children.
    pointer('pointermove', canvas, 110, 165);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('Course'), index: 0 });
    // Middle: appended as the last of A's three children.
    pointer('pointermove', canvas, 200, 165);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 3 });
    pointer('pointerup', canvas, 200, 165);
    // A deeper hierarchy node: still left/right rather than top/bottom.
    begin('B');
    pointer('pointermove', canvas, 110, 300);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 1 });
    pointer('pointermove', canvas, 290, 300);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 2 });
  });

  it('keeps top/bottom slots on balanced nodes: siblings stack vertically on both sides, so the zones need no mirror', () => {
    const { canvas, actions, node, id, pointer, begin } = fixture();
    for (const title of ['A', 'A2']) node(title).classList.add('is-balanced');
    begin('B');
    // Top edge of a balanced stage: before it among the root's children; the middle appends to it.
    pointer('pointermove', canvas, 200, 163);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('Course'), index: 0 });
    pointer('pointermove', canvas, 200, 180);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 3 });
    // The left and right edges of the node mean nothing on their own: still the child slot.
    pointer('pointermove', canvas, 110, 180);
    pointer('pointermove', canvas, 290, 180);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 3 });
    pointer('pointermove', canvas, 200, 317);
    expect(actions.preview).toHaveBeenLastCalledWith({ type: 'move', nodeId: id('B'), parentId: id('A'), index: 2 });
  });

  it('never starts a drag from a read-only node (a called map\'s, §5 M12), while the node can still be dropped on as the view decides', () => {
    const { canvas, actions, node, id, pointer, ghost, begin, center } = fixture(undefined, [], ['A2']);
    const [x, y] = center('A2');
    pointer('pointerdown', node('A2'), x, y);
    pointer('pointermove', canvas, x + 40, y);
    pointer('pointermove', canvas, x + 80, y);
    expect(ghost()).toBeNull();
    expect(node('A2').classList.contains('is-drag-source')).toBe(false);
    expect(actions.select).not.toHaveBeenCalled();
    expect(actions.readOnly).toHaveBeenCalledWith(id('A2'));
    pointer('pointerup', canvas, x + 80, y);
    expect(actions.detach).not.toHaveBeenCalled();
    // The view answers for drops on it (it refuses a called node); the drag only asks.
    begin('A3');
    pointer('pointermove', canvas, x, y);
    expect(actions.dropTarget).toHaveBeenLastCalledWith(id('A3'), id('A2'), 'inside');
    pointer('pointercancel', canvas, x, y);
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

    it('moves its own tree with live offsets and no ghost; a release on empty canvas places it', () => {
      const { canvas, actions, node, id, pointer, center, ghost } = fixture(TOPICS, ['Topic']);
      const [x, y] = center('Topic');
      pointer('pointerdown', node('Topic'), x, y);
      pointer('pointermove', canvas, x + 2, y);
      expect(actions.shift).not.toHaveBeenCalled();
      pointer('pointermove', canvas, x + 10, y + 4);
      expect(ghost()).toBeNull();
      expect(node('Topic').classList.contains('is-drag-source')).toBe(false);
      expect(canvas.classList.contains('is-dragging-node')).toBe(true);
      expect(actions.select).toHaveBeenCalledExactlyOnceWith(id('Topic'));
      expect(actions.shift).toHaveBeenLastCalledWith(id('Topic'), { x: 10, y: 4 });
      // Empty canvas: no slot, nothing previewed.
      pointer('pointermove', canvas, 700, 500);
      expect(actions.shift).toHaveBeenLastCalledWith(id('Topic'), { x: 700 - x, y: 500 - y });
      expect(actions.preview).not.toHaveBeenCalled();
      pointer('pointerup', canvas, x + 120, y - 60);
      expect(actions.place).toHaveBeenCalledExactlyOnceWith(id('Topic'), { x: 120, y: -60 });
      expect(actions.command).not.toHaveBeenCalled();
      expect(canvas.classList.contains('is-dragging-node')).toBe(false);
      // The view owns the end of a placed drag; only a cancelled one is put back through shift(null).
      expect(actions.shift).not.toHaveBeenCalledWith(id('Topic'), null);
    });

    it('previews the slot under the pointer like a tree drag and joins that node on release', () => {
      const { canvas, actions, node, id, pointer, center } = fixture(TOPICS, ['Topic']);
      const [x, y] = center('Topic');
      pointer('pointerdown', node('Topic'), x, y);
      pointer('pointermove', canvas, x + 8, y);
      const [cx, cy] = center('Child');
      pointer('pointermove', canvas, cx, cy);
      const join = { type: 'move', nodeId: id('Topic'), parentId: id('Child'), index: 0 };
      expect(actions.dropTarget).toHaveBeenLastCalledWith(id('Topic'), id('Child'), 'inside');
      expect(actions.preview).toHaveBeenLastCalledWith(join);
      expect(actions.shift).toHaveBeenLastCalledWith(id('Topic'), { x: cx - x, y: cy - y });
      pointer('pointerup', canvas, cx, cy);
      expect(actions.preview).toHaveBeenLastCalledWith(null);
      expect(actions.command).toHaveBeenCalledExactlyOnceWith(join);
      expect(actions.place).not.toHaveBeenCalled();
      expect(actions.shift).not.toHaveBeenCalledWith(id('Topic'), null);
    });

    it('asks the view for a snap slot from the root\'s own rect over empty canvas, previews it, and joins on release', () => {
      const { canvas, actions, node, id, pointer, center } = fixture(TOPICS, ['Topic']);
      const join = { type: 'move', nodeId: id('Topic'), parentId: id('Child'), index: 0 } as const;
      actions.snap.mockImplementation((_id, root) => (root.x > 400 ? join : null));
      const [x, y] = center('Topic');
      pointer('pointerdown', node('Topic'), x, y);
      pointer('pointermove', canvas, x + 8, y);
      // Over empty canvas the view is asked with the root's rect as the pointer carries it (canvas pixels), not the pointer itself.
      pointer('pointermove', canvas, 300, 300);
      expect(actions.snap).toHaveBeenLastCalledWith(id('Topic'), { x: 300 - (x - 100), y: 300 - (y - 220), width: 200, height: 40 }, null);
      expect(actions.preview).not.toHaveBeenCalled();
      // Carried beside Child: the root's left edge passes 400 and the view offers the slot.
      pointer('pointermove', canvas, x + 320, 300);
      expect(actions.snap).toHaveBeenLastCalledWith(id('Topic'), { x: 420, y: 300 - (y - 220), width: 200, height: 40 }, null);
      expect(actions.preview).toHaveBeenLastCalledWith(join);
      pointer('pointermove', canvas, x + 330, 300);
      expect(actions.snap).toHaveBeenLastCalledWith(id('Topic'), { x: 430, y: 300 - (y - 220), width: 200, height: 40 }, join);
      expect(actions.preview).toHaveBeenCalledTimes(1);
      pointer('pointerup', canvas, x + 330, 300);
      expect(actions.preview).toHaveBeenLastCalledWith(null);
      expect(actions.command).toHaveBeenCalledExactlyOnceWith(join);
      expect(actions.place).not.toHaveBeenCalled();
    });

    it('clears the slot when the snap says nothing is near', () => {
      const { canvas, actions, node, id, pointer, center } = fixture(TOPICS, ['Topic']);
      const join = { type: 'move', nodeId: id('Topic'), parentId: id('Child'), index: 0 } as const;
      actions.snap.mockImplementation((_id, root) => (root.x > 400 ? join : null));
      const [x, y] = center('Topic');
      pointer('pointerdown', node('Topic'), x, y);
      pointer('pointermove', canvas, x + 8, y);
      pointer('pointermove', canvas, x + 320, 300);
      expect(actions.preview).toHaveBeenLastCalledWith(join);
      pointer('pointermove', canvas, x, 520);
      expect(actions.preview).toHaveBeenLastCalledWith(null);
      pointer('pointerup', canvas, x, 520);
      expect(actions.command).not.toHaveBeenCalled();
      expect(actions.place).toHaveBeenCalledOnce();
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
        expect(actions.command).not.toHaveBeenCalled();
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

  describe('detaching a tree node on empty canvas', () => {
    it('detaches at the ghost position when released on empty canvas away from where it was pressed', () => {
      const { canvas, actions, node, id, pointer, center } = fixture();
      const [x, y] = center('A3');
      pointer('pointerdown', node('A3'), x, y);
      pointer('pointermove', canvas, x + 8, y);
      pointer('pointermove', canvas, 600, 500);
      expect(actions.preview).not.toHaveBeenCalled();
      pointer('pointerup', canvas, 600, 500);
      // Grabbed at its centre (100 px in from the left, 20 px from the top); the ghost's top-left is the drop point.
      expect(actions.detach).toHaveBeenCalledExactlyOnceWith(id('A3'), { x: 600 - (x - 100), y: 500 - (y - 340) });
      expect(actions.command).not.toHaveBeenCalled();
      expect(actions.place).not.toHaveBeenCalled();
    });

    it('does nothing when released back near its own place, outside the canvas, or on Escape', () => {
      const { canvas, actions, node, pointer, center } = fixture();
      const [x, y] = center('A3');
      pointer('pointerdown', node('A3'), x, y);
      pointer('pointermove', canvas, x + 8, y + 6);
      pointer('pointerup', canvas, x + 8, y + 6);
      expect(actions.detach).not.toHaveBeenCalled();
      pointer('pointerdown', node('A3'), x, y);
      pointer('pointermove', canvas, x + 8, y);
      pointer('pointermove', canvas, 900, 700);
      pointer('pointerup', canvas, 900, 700);
      expect(actions.detach).not.toHaveBeenCalled();
      pointer('pointerdown', node('A3'), x, y);
      pointer('pointermove', canvas, 600, 500);
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(actions.detach).not.toHaveBeenCalled();
      expect(actions.command).not.toHaveBeenCalled();
    });

    it('does not detach when released on a node that refused the drop', () => {
      const { canvas, actions, node, pointer, center } = fixture();
      // A dropped inside its own descendant A1 is refused; releasing there must not detach A either.
      const [x, y] = center('A');
      pointer('pointerdown', node('A'), x, y);
      pointer('pointermove', canvas, x + 8, y);
      const [ax, ay] = center('A1');
      pointer('pointermove', canvas, ax, ay);
      expect(actions.dropTarget).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'inside');
      expect(actions.preview).not.toHaveBeenCalled();
      pointer('pointerup', canvas, ax, ay);
      expect(actions.command).not.toHaveBeenCalled();
      expect(actions.detach).not.toHaveBeenCalled();
    });

    it('keeps a previewed slot over empty canvas only while nearby; far away the slot clears and a release detaches', () => {
      const { canvas, actions, id, pointer, begin, center } = fixture();
      begin('A3');
      const [ax, ay] = center('A1');
      pointer('pointermove', canvas, ax, ay - 12);
      const slot = { type: 'move', nodeId: id('A3'), parentId: id('A'), index: 0 };
      expect(actions.preview).toHaveBeenLastCalledWith(slot);
      // 20 px right of A1's box (right edge at 300): still nearby, the slot stays.
      pointer('pointermove', canvas, 320, ay);
      expect(actions.preview).toHaveBeenLastCalledWith(slot);
      // 200 px away: free again.
      pointer('pointermove', canvas, 500, ay);
      expect(actions.preview).toHaveBeenLastCalledWith(null);
      pointer('pointerup', canvas, 500, ay);
      expect(actions.command).not.toHaveBeenCalled();
      expect(actions.detach).toHaveBeenCalledOnce();
    });
  });

  it('exposes the placeholder id the view must mark on its element', () => {
    expect(PLACEHOLDER_ID).toBe('mappy-drop-placeholder');
  });
});
