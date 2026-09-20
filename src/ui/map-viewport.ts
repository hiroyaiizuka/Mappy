import { Component } from "obsidian";
import { clampScale, zoomAt, fitToBounds, type Viewport } from "../interaction/viewport";
import type { LayoutBounds } from "../layout/layout";
import { PRESS_TRAVEL } from "./map-events";

/**
 * Panning and zooming, and with them the presses on the empty canvas: a primary-button press that neither
 * travelled (a pan) nor met a second pointer (a pinch) before its release is a click on the empty canvas,
 * reported through `clicked` (the view clears the selection, §5 M12). Presses on nodes and controls never
 * reach here; a press the pointer lost (`pointercancel`) is neither.
 */
export class MapViewport extends Component {
  value: Viewport = { x: 60, y: 60, scale: 1 };
  private pointers = new Map<number, { x: number; y: number }>();
  /** The primary press on the empty canvas, and whether it still counts as a click. */
  private press: { pointerId: number; x: number; y: number; click: boolean } | null = null;

  constructor(
    private readonly canvas: HTMLElement,
    private readonly world: HTMLElement,
    private readonly changed: (viewport: Viewport) => void,
    private readonly clicked?: () => void,
  ) { super(); }

  onload(): void {
    this.registerDomEvent(this.canvas, "wheel", event => {
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.canvas.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = this.canvas.getBoundingClientRect();
        this.set(zoomAt(this.value, { x: event.clientX - rect.left, y: event.clientY - rect.top },
          this.value.scale * Math.exp(-event.deltaY * multiplier * 0.005)));
      } else this.set({ ...this.value, x: this.value.x - event.deltaX * multiplier, y: this.value.y - event.deltaY * multiplier });
    }, { passive: false });
    this.registerDomEvent(this.canvas, "pointerdown", event => {
      if (event.button !== 0 && event.button !== 1) return;
      const target = event.targetNode;
      if (target?.instanceOf(Element) && target.closest(".mappy-node, button, input, textarea")) return;
      this.canvas.focus({ preventScroll: true });
      this.canvas.setPointerCapture(event.pointerId);
      // A second pointer makes the first a pinch, not a click.
      if (this.press) this.press.click = false;
      this.press = event.button === 0 && this.pointers.size === 0 ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, click: true } : null;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.canvas.addClass("is-panning");
    });
    this.registerDomEvent(this.canvas, "pointermove", event => {
      const before = this.pointers.get(event.pointerId);
      if (!before) return;
      const press = this.press;
      if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= PRESS_TRAVEL) press.click = false;
      const other = Array.from(this.pointers).find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const oldDistance = Math.hypot(before.x - other.x, before.y - other.y);
        const newDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        const rect = this.canvas.getBoundingClientRect();
        if (oldDistance > 0) {
          const point = { x: (before.x + other.x) / 2 - rect.left, y: (before.y + other.y) / 2 - rect.top };
          const next = zoomAt(this.value, point, this.value.scale * newDistance / oldDistance);
          this.set({ ...next, x: next.x + (event.clientX - before.x) / 2, y: next.y + (event.clientY - before.y) / 2 });
        }
      } else this.set({ ...this.value, x: this.value.x + event.clientX - before.x, y: this.value.y + event.clientY - before.y });
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    const release = (event: PointerEvent): boolean => {
      const press = this.press;
      if (press?.pointerId === event.pointerId) this.press = null;
      this.pointers.delete(event.pointerId);
      if (this.pointers.size === 0) this.canvas.removeClass("is-panning");
      return press?.pointerId === event.pointerId && press.click;
    };
    this.registerDomEvent(this.canvas, "pointerup", event => { if (release(event)) this.clicked?.(); });
    this.registerDomEvent(this.canvas, "pointercancel", release);
    this.registerDomEvent(this.canvas, "lostpointercapture", release);
  }

  set(viewport: Viewport): void {
    this.value = { x: viewport.x, y: viewport.y, scale: clampScale(viewport.scale) };
    this.world.style.transform = `translate(${this.value.x}px, ${this.value.y}px) scale(${this.value.scale})`;
    this.changed(this.value);
  }

  zoom(factor: number): void {
    this.set(zoomAt(this.value, { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 }, this.value.scale * factor));
  }

  fit(bounds: LayoutBounds): void { this.set(fitToBounds(bounds, this.canvas.clientWidth, this.canvas.clientHeight)); }
}
