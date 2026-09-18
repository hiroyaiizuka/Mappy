import { describe, expect, it } from 'vitest';
import { pathToPoints } from '../../src/layout/path-points';
import { layoutTree } from '../../src/layout/layout';

describe('pathToPoints', () => {
  it('converts rightward branch paths into four corner points', () => {
    expect(pathToPoints('M 160 22 H 200 V 80 H 240')).toEqual([[160, 22], [200, 22], [200, 80], [240, 80]]);
  });

  it('converts timeline axis and stem paths', () => {
    expect(pathToPoints('M 160 0 H 192')).toEqual([[160, 0], [192, 0]]);
    expect(pathToPoints('M 250 -22 V -70 H 300')).toEqual([[250, -22], [250, -70], [300, -70]]);
  });

  it('drops zero-length segments and supports L', () => {
    expect(pathToPoints('M 0 0 H 0 V 10 L 5 5')).toEqual([[0, 0], [0, 10], [5, 5]]);
  });

  it('rejects unsupported commands and malformed numbers', () => {
    expect(() => pathToPoints('M 0 0 C 1 1 2 2 3 3')).toThrow(/Unsupported path command/u);
    expect(() => pathToPoints('M 0 x')).toThrow(/Unsupported path token/u);
    expect(() => pathToPoints('H 5')).toThrow(/current point/u);
  });

  it('accepts every edge produced by layoutTree in every mode', () => {
    const tree = { id: 'r', children: [
      { id: 'a', children: [{ id: 'a1', children: [] }, { id: 'a2', children: [] }] },
      { id: 'b', children: [{ id: 'b1', children: [] }] },
    ] };
    const sizes = new Map([['r', { width: 100, height: 40 }], ['a', { width: 80, height: 30 }]]);
    for (const mode of ['mindmap', 'timeline', 'hierarchy'] as const) {
      const layout = layoutTree(tree, sizes, new Set(), mode);
      for (const edge of layout.edges) expect(pathToPoints(edge.path).length).toBeGreaterThanOrEqual(2);
    }
  });
});
