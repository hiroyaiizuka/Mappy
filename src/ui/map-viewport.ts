import { Component } from "obsidian";
import { clampScale, zoomAt, fitToBounds, type Viewport } from "../interaction/viewport";
import type { LayoutBounds } from "../layout/layout";

export class MapViewport extends Component {
  value: Viewport = { x: 60, y: 60, scale: 1 };
  private pointers = new Map<number, { x: number; y: number }>();

  constructor(
    private readonly canvas: HTMLElement,
    private readonly world: HTMLElement,
    private readonly changed: (viewport: Viewport) => void,
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
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.canvas.addClass("is-panning");
    });
    this.registerDomEvent(this.canvas, "pointermove", event => {
      const before = this.pointers.get(event.pointerId);
      if (!before) return;
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
    const release = (event: PointerEvent): void => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size === 0) this.canvas.removeClass("is-panning");
    };
    this.registerDomEvent(this.canvas, "pointerup", release);
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
