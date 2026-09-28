// @vitest-environment jsdom
/**
 * The connectors the embed, the export and (since LEV-248) the map view draw. `each` is the map view's: it marks the drop
 * preview's connector and draws it last, as `drawEdges` did with its own copy of this loop.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installObsidianDom } from '../browser-harness/dom';
import type { LayoutEdge } from '../../src/layout/layout';
import { EdgeLayer } from '../../src/ui/edge-layer';

beforeAll(() => { installObsidianDom(); });

const edge = (from: string, to: string, path = `M0 0L${to.length} 1`): LayoutEdge => ({ id: `${from}->${to}`, from, to, path });

describe('EdgeLayer', () => {
  it('keeps a path per edge id across updates, sets only a changed d, and removes the edges gone', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = new EdgeLayer(svg);
    layer.update([edge('a', 'b'), edge('a', 'c')]);
    const [first] = Array.from(svg.children);
    layer.update([edge('a', 'b', 'M1 1L2 2')]);
    expect(svg.children).toHaveLength(1);
    expect(svg.firstElementChild).toBe(first);
    expect(first?.getAttribute('d')).toBe('M1 1L2 2');
  });

  it('calls each with every edge and its path, in order, once the path has its d', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = new EdgeLayer(svg);
    const seen: string[] = [];
    layer.update([edge('a', 'b'), edge('a', 'c')], (item, path) => { seen.push(`${item.id} ${path.getAttribute('d')}`); });
    expect(seen).toEqual(['a->b M0 0L1 1', 'a->c M0 0L1 1']);
  });
});
