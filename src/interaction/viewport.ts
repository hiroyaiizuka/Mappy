export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

interface Point {
  x: number;
  y: number;
}

interface Bounds extends Point {
  width: number;
  height: number;
}

export function clampScale(scale: number): number {
  // Fit needs smaller scales for long outlines. Share the same range with
  // manual zoom so the first wheel/button step does not jump back to 15%.
  return Number.isNaN(scale) ? 1 : Math.min(3, Math.max(0.000001, scale));
}

/** The pointer is expressed relative to the viewport's top-left corner. */
export function zoomAt(view: Viewport, point: Point, nextScale: number): Viewport {
  const scale = clampScale(nextScale);
  const currentScale = clampScale(view.scale);
  return {
    x: point.x - (point.x - view.x) / currentScale * scale,
    y: point.y - (point.y - view.y) / currentScale * scale,
    scale,
  };
}

export function fitToBounds(bounds: Bounds, width: number, height: number, padding = 60): Viewport {
  const viewportWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const viewportHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const inset = Number.isFinite(padding) ? Math.max(0, padding) : 60;
  const contentWidth = Number.isFinite(bounds.width) ? Math.max(1, bounds.width) : 1;
  const contentHeight = Number.isFinite(bounds.height) ? Math.max(1, bounds.height) : 1;
  const scale = clampScale(Math.min(
    Math.max(1, viewportWidth - inset * 2) / contentWidth,
    Math.max(1, viewportHeight - inset * 2) / contentHeight,
  ));
  return {
    x: viewportWidth / 2 - (bounds.x + contentWidth / 2) * scale,
    y: viewportHeight / 2 - (bounds.y + contentHeight / 2) * scale,
    scale,
  };
}
