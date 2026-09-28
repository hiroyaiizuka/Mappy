// @vitest-environment jsdom
/**
 * The connectors the embed, the export and (since LEV-248) the map view draw. `path` is the map view's: it marks the
 * drop preview's connector and draws it last. Pins, not regression tests: the first two hold on `EdgeLayer` before
 * LEV-248 too (what the map view now relies on: one path per edge id, `d` set only when it changed), the last is new.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../browser-harness/dom';
import type { LayoutEdge } from '../../src/layout/layout';
import { EdgeLayer } from '../../src/ui/edge-layer';

beforeAll(() => { installObsidianDom(); });

const edge = (from: string, to: string, path = `M0 0L${to.length} 1`): LayoutEdge => ({ id: `${from}->${to}`, from, to, path });

describe('EdgeLayer', () => {
  it('keeps a path per edge id across updates and removes the edges gone', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = new EdgeLayer(svg);
    layer.update([edge('a', 'b'), edge('a', 'c')]);
    const [first] = Array.from(svg.children);
    layer.update([edge('a', 'b', 'M1 1L2 2')]);
    expect(svg.children).toHaveLength(1);
    expect(svg.firstElementChild).toBe(first);
    expect(first?.getAttribute('d')).toBe('M1 1L2 2');
  });

  it('touches only a changed d', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = new EdgeLayer(svg);
    layer.update([edge('a', 'b'), edge('a', 'c')]);
    const unchanged = layer.path('a->b');
    const changed = layer.path('a->c');
    if (!unchanged || !changed) throw new Error('No paths');
    const kept = vi.spyOn(unchanged, 'setAttribute');
    const moved = vi.spyOn(changed, 'setAttribute');
    layer.update([edge('a', 'b'), edge('a', 'c', 'M5 5L6 6')]);
    expect({ kept: kept.mock.calls.length, moved: moved.mock.calls }).toEqual({ kept: 0, moved: [['d', 'M5 5L6 6']] });
  });

  it('gives the path of an edge drawn by the last update, and none for an edge gone', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = new EdgeLayer(svg);
    layer.update([edge('a', 'b')]);
    expect(layer.path('a->b')).toBe(svg.firstElementChild);
    layer.update([]);
    expect(layer.path('a->b')).toBeUndefined();
  });
});
