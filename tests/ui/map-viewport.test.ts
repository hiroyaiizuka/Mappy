// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MapViewport } from '../../src/ui/map-viewport';

// The empty-canvas click of §5 M12 (a call then adds a free topic) is MapViewport's judgement, made
// where pans and pinches are: a primary press released without travel and without a second pointer.
const originalTargetNode = Object.getOwnPropertyDescriptor(UIEvent.prototype, 'targetNode');
const originalInstanceOf = Object.getOwnPropertyDescriptor(Node.prototype, 'instanceOf');
const components = new Set<MapViewport>();

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
  const canvas = document.createElement('div');
  canvas.tabIndex = 0;
  canvas.setPointerCapture = () => undefined;
  canvas.releasePointerCapture = () => undefined;
  canvas.addClass = (...classes: string[]) => { canvas.classList.add(...classes); };
  canvas.removeClass = (...classes: string[]) => { canvas.classList.remove(...classes); };
  const world = document.createElement('div');
  canvas.append(world);
  const node = document.createElement('div');
  node.className = 'mappy-node';
  world.append(node);
  document.body.append(canvas);
  const changed = vi.fn();
  const clicked = vi.fn();
  const viewport = new MapViewport(canvas, world, changed, clicked);
  components.add(viewport);
  viewport.load();
  const pointer = (type: string, target: EventTarget, clientX: number, clientY: number, init: PointerEventInit = {}): void => {
    target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX, clientY, ...init }));
  };
  return { canvas, world, node, viewport, changed, clicked, pointer };
}

describe('MapViewport reports a click on the empty canvas', () => {
  it('after a primary press released where it began, on the canvas or its world, and not after a pan', () => {
    const { canvas, world, clicked, pointer, viewport } = fixture();
    pointer('pointerdown', canvas, 100, 100);
    pointer('pointerup', canvas, 102, 101);
    expect(clicked).toHaveBeenCalledOnce();
    pointer('pointerdown', world, 200, 200);
    pointer('pointerup', world, 200, 200);
    expect(clicked).toHaveBeenCalledTimes(2);
    // A pan: the pointer travelled before the release, even if it came back.
    const before = { ...viewport.value };
    pointer('pointerdown', canvas, 100, 100);
    pointer('pointermove', canvas, 160, 130);
    pointer('pointermove', canvas, 100, 100);
    pointer('pointerup', canvas, 100, 100);
    expect(clicked).toHaveBeenCalledTimes(2);
    expect(viewport.value).toEqual(before);
    // Travel under the threshold still pans by that much and is still a click.
    pointer('pointerdown', canvas, 100, 100);
    pointer('pointermove', canvas, 102, 101);
    pointer('pointerup', canvas, 102, 101);
    expect(clicked).toHaveBeenCalledTimes(3);
    expect(viewport.value).toEqual({ ...before, x: before.x + 2, y: before.y + 1 });
    expect(canvas.classList.contains('is-panning')).toBe(false);
  });

  it('not for a press on a node or a control, the middle button, a pinch, or a press the pointer lost', () => {
    const { canvas, node, clicked, pointer } = fixture();
    pointer('pointerdown', node, 100, 100);
    pointer('pointerup', node, 100, 100);
    const button = document.createElement('button');
    canvas.append(button);
    pointer('pointerdown', button, 100, 100);
    pointer('pointerup', button, 100, 100);
    pointer('pointerdown', canvas, 100, 100, { button: 1 });
    pointer('pointerup', canvas, 100, 100, { button: 1 });
    expect(clicked).not.toHaveBeenCalled();
    // A second pointer during the press: a pinch, whichever pointer lifts first.
    pointer('pointerdown', canvas, 100, 100);
    pointer('pointerdown', canvas, 300, 300, { pointerId: 2 });
    pointer('pointerup', canvas, 300, 300, { pointerId: 2 });
    pointer('pointerup', canvas, 100, 100);
    expect(clicked).not.toHaveBeenCalled();
    pointer('pointerdown', canvas, 100, 100);
    pointer('pointercancel', canvas, 100, 100);
    pointer('pointerup', canvas, 100, 100);
    expect(clicked).not.toHaveBeenCalled();
    expect(canvas.classList.contains('is-panning')).toBe(false);
    // The next plain press is judged on its own.
    pointer('pointerdown', canvas, 100, 100);
    pointer('pointerup', canvas, 100, 100);
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe('MapViewport moves the world with a 2D transform only (LEV-213)', () => {
  // A 3D transform (translate3d, scale3d, translateZ…) promotes the world to a layer of its own, as `will-change` did:
  // every pan and zoom then re-layerized all 2,000 nodes of E45's mixed map on the main thread, p95 0.45–0.97 s per wheel
  // event (E75 times it on the real Obsidian; tests/tooling/ui-css.test.mjs pins the stylesheet's side).
  it('after a wheel pan and a ⌘-wheel zoom', () => {
    const { canvas, world } = fixture();
    const twoD = /^translate\(-?[\d.e-]+px, -?[\d.e-]+px\) scale\([\d.e-]+\)$/u;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 24, deltaY: 12, bubbles: true, cancelable: true }));
    expect(world.style.transform).toMatch(twoD);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -8, metaKey: true, clientX: 50, clientY: 40, bubbles: true, cancelable: true }));
    expect(world.style.transform).toMatch(twoD);
    expect(world.style.transform).not.toMatch(/scale\(1\)$/u);
  });
});
