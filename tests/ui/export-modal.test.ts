// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { ExportModal } from '../../src/ui/export-modal';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

function buttons(): Map<string, HTMLButtonElement> {
  return new Map(Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button'), button => [button.textContent ?? '', button]));
}

describe('ExportModal', () => {
  it('offers SVG and PNG, reports the choice once and closes', () => {
    const choose = vi.fn();
    new ExportModal({} as App, true, choose).open();
    expect(document.querySelector('.modal-title')?.textContent).toBe('SVG／PNG に書き出し');
    expect(document.querySelector('.modal-content')?.textContent).toContain('フォント');
    const svg = buttons().get('SVG');
    const png = buttons().get('PNG');
    expect(svg?.disabled).toBe(false);
    expect(png?.disabled).toBe(false);
    png?.click();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith('png');
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('disables PNG and says why when the host cannot rasterise', () => {
    const choose = vi.fn();
    new ExportModal({} as App, false, choose).open();
    expect(buttons().get('PNG')?.disabled).toBe(true);
    expect(document.querySelector('.modal-content')?.textContent).toContain('SVG だけ');
    buttons().get('SVG')?.click();
    expect(choose).toHaveBeenCalledWith('svg');
  });
});
