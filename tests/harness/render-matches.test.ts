// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { renderMatches } from '../../harness/browser/obsidian';

// The stand-in for Obsidian's renderMatches follows the 1.14.2 implementation read from the running app
// (artifacts/lev-71-map-search-e2e/record.md, 6b): the map search relies on these rules for the title line.
beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

/** The rendered text as one string, matched runs in brackets. */
function render(text: string, matches: [number, number][] | null, offset?: number): string {
  const el = document.body.createDiv();
  renderMatches(el, text, matches, offset);
  return Array.from(el.childNodes, node => (node instanceof HTMLElement && node.hasClass('suggestion-highlight') ? `[${node.textContent}]` : node.textContent ?? '')).join('');
}

describe('renderMatches (browser-harness stand-in)', () => {
  it('writes the plain text when there is nothing to mark', () => {
    expect(render('Fixtures', null)).toBe('Fixtures');
    expect(render('Fixtures', [])).toBe('Fixtures');
  });

  it('marks sorted, disjoint ranges in place with offset 0', () => {
    expect(render('Fixtures/embed-timeline', [[0, 8], [9, 14]])).toBe('[Fixtures]/[embed]-timeline');
    expect(render('uneven-branches', [[0, 6]], 0)).toBe('[uneven]-branches');
  });

  it('adds a negative offset to the ranges so the title line shows the part after the folder', () => {
    // `Fixtures/uneven-branches` matched at [9, 15): the title starts 9 characters in.
    expect(render('uneven-branches', [[9, 15]], -9)).toBe('[uneven]-branches');
    // A range that ends at or before the start of the text is skipped; one across the start is clamped to 0.
    expect(render('embed-timeline', [[0, 8], [9, 14]], -9)).toBe('[embed]-timeline');
    expect(render('embed-timeline', [[0, 14]], -9)).toBe('[embed]-timeline');
  });

  it('stops at a range that starts past the end and clamps one that runs past it', () => {
    // The folder line gets the same ranges: what falls beyond the folder is dropped.
    expect(render('Fixtures', [[0, 8], [9, 14]])).toBe('[Fixtures]');
    expect(render('Fixtures', [[0, 14]])).toBe('[Fixtures]');
    expect(render('Fixtures', [[9, 14]])).toBe('Fixtures');
    // Once the cursor is at the end, later ranges are not looked at.
    expect(render('Fixtures', [[0, 14], [3, 5]])).toBe('[Fixtures]');
  });

  it('repeats the overlap of an overlapping range, as the real substring-based loop does', () => {
    expect(render('abcdef', [[0, 3], [2, 5]])).toBe('[abc]c[cde]f');
  });
});
