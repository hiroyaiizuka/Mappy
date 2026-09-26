import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/core/commands';
import { readMapFromSource } from '../../src/core/embed';
import { planMapLayout } from '../../src/core/layout-key';
import type { LayoutMode } from '../../src/core/layout-mode';

const write = (source: string, layout: LayoutMode): string => applyEdits(source, planMapLayout(source, layout));

describe('planMapLayout (a layout button, LEV-196)', () => {
  it('adds the layout line before the closing delimiter and leaves every other byte alone', () => {
    const source = '---\ntags: [a, "b"]   # kept as typed\nmappy: true\n---\n## Map\n\n- Node\n';
    expect(write(source, 'timeline')).toBe('---\ntags: [a, "b"]   # kept as typed\nmappy: true\nmappy-layout: timeline\n---\n## Map\n\n- Node\n');
  });

  it('replaces the value in place, quoted or not, and removes the key for the regular map', () => {
    const source = '---\nmappy: true\nmappy-layout: "hierarchy"\naliases: [x]\n---\n# Map\n';
    expect(write(source, 'balanced')).toBe('---\nmappy: true\nmappy-layout: balanced\naliases: [x]\n---\n# Map\n');
    expect(write(source, 'mindmap')).toBe('---\nmappy: true\naliases: [x]\n---\n# Map\n');
  });

  it('writes nothing when the note already asks for the layout, in any spelling the readers accept', () => {
    expect(planMapLayout('---\nmappy: true\nmappy-layout: " Timeline "\n---\n', 'timeline')).toEqual([]);
    expect(planMapLayout('---\nmappy: true\n---\n', 'mindmap')).toEqual([]);
  });

  it('makes the note a map as `writeMapLayout` does: a missing or non-true `mappy` becomes `mappy: true`', () => {
    expect(write('---\ntags: [a]\n---\n# Map\n', 'timeline')).toBe('---\ntags: [a]\nmappy: true\nmappy-layout: timeline\n---\n# Map\n');
    expect(write('---\nmappy: "true"\n---\n# Map\n', 'mindmap')).toBe('---\nmappy: true\n---\n# Map\n');
    expect(write('# Map\n', 'hierarchy')).toBe('---\nmappy: true\nmappy-layout: hierarchy\n---\n# Map\n');
    expect(write('﻿# Map\n', 'mindmap')).toBe('﻿---\nmappy: true\n---\n# Map\n');
  });

  it('keeps the note\'s line endings', () => {
    expect(write('---\r\nmappy: true\r\n---\r\n# Map\r\n', 'timeline')).toBe('---\r\nmappy: true\r\nmappy-layout: timeline\r\n---\r\n# Map\r\n');
  });

  it('refuses an unfinished header rather than guessing where it ends', () => {
    expect(() => planMapLayout('---\nmappy: true\n# Map\n', 'timeline')).toThrow('frontmatter を閉じて');
  });

  it.each(['mindmap', 'timeline', 'hierarchy', 'balanced'] as const)('reads back as %s through the text reader', layout => {
    expect(readMapFromSource(write('---\nmappy: true\nmappy-layout: timeline\n---\n# Map\n', layout))).toBe(layout);
  });
});
