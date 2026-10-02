import { describe, expect, it } from 'vitest';
import { webSearchAfterAttach, webSearchCaution } from '../../../src/ai/core/web-search';

describe('web search and material (decision A, 2026-10-02)', () => {
  it('turns web search off with the first material, and leaves the person’s choice alone after that', () => {
    expect(webSearchAfterAttach(true, 0)).toBe(false);
    expect(webSearchAfterAttach(false, 0)).toBe(false);
    expect(webSearchAfterAttach(true, 1)).toBe(true);
    expect(webSearchAfterAttach(false, 2)).toBe(false);
  });

  it('cautions only while web search is on with material attached', () => {
    expect(webSearchCaution(1, true)).toBe(true);
    expect(webSearchCaution(1, false)).toBe(false);
    expect(webSearchCaution(0, true)).toBe(false);
  });
});
