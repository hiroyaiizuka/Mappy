import { TFile, loadPdfJs, type App } from 'obsidian';
import type { AiFailure } from '../contract';
import { LIMITS } from '../core/launch';

/**
 * The materials that come from the vault (docs/architecture.md §11.2), read through Obsidian's API: a PDF's text
 * through the pdf.js Obsidian ships (`loadPdfJs()`), a note through the plugin's document store (which sees an open
 * editor's unsaved text). YouTube goes through yt-dlp in `src/ai/host/`.
 */

export type MaterialText =
  | { kind: 'ok'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: AiFailure; detail: string };

export interface VaultMaterials {
  pdf(path: string, signal: AbortSignal): Promise<MaterialText>;
  note(path: string): Promise<MaterialText>;
}

/** The part of pdf.js used (Obsidian 1.14.2 ships 5.3.34, artifacts/lev-270 probe-pdf). */
interface PdfJs {
  getDocument(source: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}
interface PdfDocument {
  numPages: number;
  getPage(number: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>;
  destroy?(): Promise<void>;
}

/**
 * A page's text. NFKC because pdf.js gives a CJK PDF's characters as the compatibility forms its fonts map them to
 * (`⽇本語` for 日本語, artifacts/lev-270 probe-pdf), which read as other characters to the model.
 */
function pageText(items: readonly { str?: string; hasEOL?: boolean }[]): string {
  return items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join('').normalize('NFKC').trim();
}

export function vaultMaterials(app: App, readNote: (file: TFile) => Promise<string>): VaultMaterials {
  const fileAt = (path: string): TFile | null => {
    const file = app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  };
  return {
    async pdf(path, signal) {
      const file = fileAt(path);
      if (!file) return { kind: 'failed', reason: 'material-failed', detail: path };
      if (file.stat.size > LIMITS.pdfMaxBytes) {
        return { kind: 'failed', reason: 'material-too-large', detail: `${path}: ${file.stat.size} / ${LIMITS.pdfMaxBytes} bytes` };
      }
      let document: PdfDocument | null = null;
      try {
        const pdfjs = await loadPdfJs() as PdfJs;
        document = await pdfjs.getDocument({ data: new Uint8Array(await app.vault.readBinary(file)) }).promise;
        const pages: string[] = [];
        for (let number = 1; number <= document.numPages; number++) {
          if (signal.aborted) return { kind: 'cancelled' };
          const text = pageText((await (await document.getPage(number)).getTextContent()).items);
          if (text) pages.push(`[p.${number}]\n${text}`);
        }
        // A scanned PDF has pages but no text; there is no OCR.
        return pages.length > 0 ? { kind: 'ok', text: pages.join('\n\n') } : { kind: 'failed', reason: 'no-pdf-text', detail: path };
      } catch (error) {
        return { kind: 'failed', reason: 'material-failed', detail: `${path}: ${String(error)}` };
      } finally {
        await document?.destroy?.().catch(() => undefined);
      }
    },
    async note(path) {
      const file = fileAt(path);
      if (!file) return { kind: 'failed', reason: 'material-failed', detail: path };
      try {
        return { kind: 'ok', text: await readNote(file) };
      } catch (error) {
        return { kind: 'failed', reason: 'material-failed', detail: `${path}: ${String(error)}` };
      }
    },
  };
}
