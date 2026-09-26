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

  it('writes nothing to a note that is not a map: a button neither makes one nor leaves a layout for the next conversion', () => {
    expect(planMapLayout('---\ntags: [a]\n---\n# Note\n', 'timeline')).toEqual([]);
    expect(planMapLayout('---\nmappy: "true"\nmappy-layout: timeline\n---\n# Note\n', 'mindmap')).toEqual([]);
    expect(planMapLayout('# Note\n', 'hierarchy')).toEqual([]);
    expect(planMapLayout('---\nmappy: true\nexcalidraw-plugin: parsed\n---\n# Drawing\n', 'timeline')).toEqual([]);
    expect(planMapLayout('---\nmappy: true\n# an unfinished header\n', 'hierarchy')).toEqual([]);
  });

  it('keeps the note\'s line endings', () => {
    expect(write('---\r\nmappy: true\r\n---\r\n# Map\r\n', 'timeline')).toBe('---\r\nmappy: true\r\nmappy-layout: timeline\r\n---\r\n# Map\r\n');
  });

  it.each(['mindmap', 'timeline', 'hierarchy', 'balanced'] as const)('reads back as %s through the text reader', layout => {
    expect(readMapFromSource(write('---\nmappy: true\nmappy-layout: timeline\n---\n# Map\n', layout))).toBe(layout);
  });
});
