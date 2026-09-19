import { describe, expect, it } from 'vitest';
import {
  EXPORT_MARGIN, StyleRegistry, buildSvg, escapeAttribute, escapeText, formatNumber, pngScale, svgSize, type SvgScene,
} from '../../src/export/svg-document';

function scene(overrides: Partial<SvgScene> = {}): SvgScene {
  return {
    theme: 'light',
    background: 'rgb(255, 255, 255)',
    bounds: { x: -10.5, y: 20, width: 300.25, height: 120 },
    nodes: [
      { id: 'root', x: 0, y: 40, width: 120, height: 44, html: '<div xmlns="http://www.w3.org/1999/xhtml" class="mappy-node is-root m0">講座</div>' },
      { id: 'n1', x: 200, y: 20, width: 90.5, height: 30, html: '<div xmlns="http://www.w3.org/1999/xhtml" class="mappy-node m1">a &amp; b</div>' },
    ],
    edges: [{ path: 'M120 62 H160 V35 H200' }],
    badges: [],
    css: '.m0{color:rgb(0, 0, 0)}\n.m1{color:rgb(0, 0, 0)}',
    ...overrides,
  };
}

describe('svgSize', () => {
  it('adds the margin on every side and rounds the size up to whole pixels', () => {
    const size = svgSize({ x: -10.5, y: 20, width: 300.25, height: 120 });
    expect(size.width).toBe(Math.ceil(300.25 + EXPORT_MARGIN * 2));
    expect(size.height).toBe(120 + EXPORT_MARGIN * 2);
    expect(size.viewBox).toBe(`-34.5 -4 ${size.width} ${size.height}`);
  });

  it('never yields an empty document', () => {
    expect(svgSize({ x: 0, y: 0, width: 0, height: 0 }, 0)).toEqual({ width: 1, height: 1, viewBox: '0 0 1 1' });
  });
});

describe('pngScale', () => {
  const limits = { preferred: 2, maxPixels: 1_000_000, maxSide: 2_000 };

  it('uses the preferred scale while the canvas fits', () => {
    expect(pngScale({ width: 400, height: 300 }, limits)).toBe(2);
  });

  it('shrinks to the pixel budget for a large map instead of refusing', () => {
    const scale = pngScale({ width: 4_000, height: 2_000 }, limits);
    expect(scale).toBeCloseTo(Math.sqrt(1_000_000 / 8_000_000), 6);
    expect(4_000 * scale * 2_000 * scale).toBeLessThanOrEqual(1_000_000 + 1);
  });

  it('respects the longest side too', () => {
    expect(pngScale({ width: 1_600, height: 10 }, limits)).toBe(2_000 / 1_600);
    expect(pngScale({ width: 0, height: 0 }, limits)).toBeGreaterThan(0);
  });
});

describe('escaping and numbers', () => {
  it('escapes markup in text and quotes in attributes', () => {
    expect(escapeText('a < b & c > "d"')).toBe('a &lt; b &amp; c &gt; "d"');
    expect(escapeAttribute('say "hi" & <go>')).toBe('say &quot;hi&quot; &amp; &lt;go&gt;');
  });

  it('keeps two decimals at most and drops trailing zeros', () => {
    expect(formatNumber(12)).toBe('12');
    expect(formatNumber(12.5)).toBe('12.5');
    expect(formatNumber(12.345)).toBe('12.35');
    expect(formatNumber(-0.004)).toBe('0');
  });
});

describe('StyleRegistry', () => {
  it('names each distinct declaration list once and skips empty ones', () => {
    const registry = new StyleRegistry();
    expect(registry.classFor('color:red')).toBe('m0');
    expect(registry.classFor('color:blue')).toBe('m1');
    expect(registry.classFor('color:red')).toBe('m0');
    expect(registry.classFor('')).toBeNull();
    expect(registry.size).toBe(2);
    expect(registry.css()).toBe('.m0{color:red}\n.m1{color:blue}');
  });
});

describe('buildSvg', () => {
  it('writes the size, viewBox, theme class, background, edges, nodes and their order', () => {
    const svg = buildSvg(scene());
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ')).toBe(true);
    expect(svg).toContain(`width="${Math.ceil(300.25 + 48)}" height="168" viewBox="-34.5 -4 ${Math.ceil(300.25 + 48)} 168"`);
    expect(svg).toContain('class="mappy-export theme-light" data-theme="light" data-nodes="2" data-edges="1"');
    expect(svg).toContain('<rect x="-34.5" y="-4" width="349" height="168" class="mappy-export-background" fill="rgb(255, 255, 255)"/>');
    expect(svg).toContain('<path d="M120 62 H160 V35 H200"/>');
    expect(svg).toContain('<foreignObject data-node-id="root" x="0" y="40" width="120" height="44" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" class="mappy-node is-root m0">講座</div></foreignObject>');
    expect(svg).toContain('<foreignObject data-node-id="n1" x="200" y="20" width="90.5" height="30" overflow="visible">');
    // Connectors are drawn before the nodes so text sits on top of the lines.
    expect(svg.indexOf('<g class="mappy-edges">')).toBeLessThan(svg.indexOf('<g class="mappy-nodes">'));
    expect(svg).toContain('<style><![CDATA[\n.m0{color:rgb(0, 0, 0)}\n.m1{color:rgb(0, 0, 0)}\n]]></style>');
    expect(svg).not.toContain('mappy-folds');
    expect(svg.endsWith('</svg>\n')).toBe(true);
  });

  it('draws a pill and the count for every badge, and marks the dark theme', () => {
    const svg = buildSvg(scene({ theme: 'dark', background: 'rgb(30, 30, 30)', badges: [{ x: 100, y: 91, width: 24, height: 18, text: '24' }] }));
    expect(svg).toContain('class="mappy-export theme-dark" data-theme="dark"');
    expect(svg).toContain('fill="rgb(30, 30, 30)"');
    expect(svg).toContain('<rect x="100" y="91" width="24" height="18" rx="9" ry="9" class="mappy-fold-pill"/>');
    expect(svg).toContain('<text x="112" y="100" text-anchor="middle" dominant-baseline="central" class="mappy-fold-text">24</text>');
  });

  it('keeps the stylesheet well formed even if a declaration contains the CDATA terminator', () => {
    const svg = buildSvg(scene({ css: '.m0{content:"]]>"}' }));
    expect(svg).toContain('<![CDATA[\n.m0{content:"]]]]><![CDATA[>"}\n]]>');
    expect(svg).toContain('<path d="M120 62 H160 V35 H200"/>');
  });
});
