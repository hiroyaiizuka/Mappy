import type { LayoutEdge } from "../layout/layout";

/** Connector paths keyed by edge id; only changed connectors touch the DOM across frames. */
export class EdgeLayer {
  private readonly paths = new Map<string, SVGPathElement>();

  constructor(private readonly svg: SVGSVGElement) {}

  /**
   * `each`, when given, is called with every edge's path once its `d` is set, in the order of `edges`: the map view
   * marks the drop preview's connector there and draws it last (LEV-248).
   */
  update(edges: readonly LayoutEdge[], each?: (edge: LayoutEdge, path: SVGPathElement) => void): void {
    const retained = new Set<string>();
    for (const edge of edges) {
      retained.add(edge.id);
      let path = this.paths.get(edge.id);
      if (!path) {
        path = this.svg.createSvg("path");
        this.paths.set(edge.id, path);
      }
      if (path.getAttribute("d") !== edge.path) path.setAttribute("d", edge.path);
      each?.(edge, path);
    }
    for (const [id, path] of this.paths) {
      if (retained.has(id)) continue;
      path.remove();
      this.paths.delete(id);
    }
  }

  clear(): void {
    for (const path of this.paths.values()) path.remove();
    this.paths.clear();
  }
}
