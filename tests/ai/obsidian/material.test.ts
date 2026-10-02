import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { TFile, loadPdfJs } from 'obsidian';
import { vaultMaterials } from '../../../src/ai/obsidian/material';

vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<typeof import('obsidian')>(), loadPdfJs: vi.fn() }));

/** A vault with one file at `path` (size in bytes) and a pdf.js that returns `pages` as text items. */
function setup(pages: string[][], size = 1_000) {
  const file = Object.assign(new TFile(), { path: 'docs/a.pdf', stat: { size, ctime: 0, mtime: 0 } });
  const destroy = vi.fn(() => Promise.resolve());
  vi.mocked(loadPdfJs).mockResolvedValue({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: (number: number) => Promise.resolve({
          getTextContent: () => Promise.resolve({ items: (pages[number - 1] ?? []).map(str => ({ str, hasEOL: str.endsWith(' ') })) }),
        }),
        destroy,
      }),
    }),
  });
  const readBinary = vi.fn<(file: TFile) => Promise<ArrayBuffer>>(() => Promise.resolve(new ArrayBuffer(8)));
  const app = {
    vault: { getAbstractFileByPath: (path: string) => path === 'docs/a.pdf' || path === 'notes/n.md' ? file : null, readBinary },
  } as unknown as App;
  return { materials: vaultMaterials(app, () => Promise.resolve('unsaved editor text')), destroy, readBinary };
}

describe('vaultMaterials.pdf (architecture.md §11.2)', () => {
  it('gives each page under [p.N], in NFKC (pdf.js gives CJK in compatibility forms, artifacts/lev-270 probe-pdf)', async () => {
    const { materials, destroy } = setup([['⽇本語の ', 'テスト'], [], ['⼆ページ⽬']]);
    await expect(materials.pdf('docs/a.pdf', new AbortController().signal)).resolves.toEqual({ kind: 'ok', text: '[p.1]\n日本語の \nテスト\n\n[p.3]\n二ページ目' });
    expect(destroy).toHaveBeenCalled();
  });

  it('says there is no text for a scanned PDF (no OCR)', async () => {
    const { materials } = setup([[], ['  ']]);
    await expect(materials.pdf('docs/a.pdf', new AbortController().signal)).resolves.toEqual({ kind: 'failed', reason: 'no-pdf-text', detail: 'docs/a.pdf' });
  });

  it('refuses a PDF over 50 MB before reading it', async () => {
    const { materials, readBinary } = setup([['x']], 50 * 1024 * 1024 + 1);
    await expect(materials.pdf('docs/a.pdf', new AbortController().signal)).resolves.toMatchObject({ kind: 'failed', reason: 'material-too-large' });
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('stops between pages when cancelled', async () => {
    const { materials } = setup([['a'], ['b']]);
    const controller = new AbortController();
    controller.abort();
    await expect(materials.pdf('docs/a.pdf', controller.signal)).resolves.toEqual({ kind: 'cancelled' });
  });

  it('reports a missing file and a pdf.js failure', async () => {
    const { materials } = setup([['a']]);
    await expect(materials.pdf('nowhere.pdf', new AbortController().signal)).resolves.toMatchObject({ kind: 'failed', reason: 'material-failed' });
    vi.mocked(loadPdfJs).mockRejectedValueOnce(new Error('broken'));
    await expect(materials.pdf('docs/a.pdf', new AbortController().signal)).resolves.toMatchObject({ kind: 'failed', reason: 'material-failed' });
  });
});

describe('vaultMaterials.note', () => {
  it('reads through the store (an open editor’s unsaved text)', async () => {
    const { materials } = setup([]);
    await expect(materials.note('notes/n.md')).resolves.toEqual({ kind: 'ok', text: 'unsaved editor text' });
    await expect(materials.note('missing.md')).resolves.toMatchObject({ kind: 'failed', reason: 'material-failed' });
  });
});
