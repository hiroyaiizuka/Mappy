import { t } from "../i18n";
import { ConflictError } from "../obsidian/conflict-error";

/**
 * A draft's error line (the inline editor's and the body modal's): why a save was refused, and, when the refusal was
 * a conflict, the swap to the retry line once the map has re-read the note. The kind is kept from the error itself,
 * never read back from the text, which follows the app's language (architecture.md §9e).
 */
export class RefusalLine {
  private conflicted = false;

  constructor(private readonly element: HTMLElement) {}

  show(error: unknown): void {
    this.element.setText(error instanceof Error ? error.message : t().saveFailed);
    this.conflicted = error instanceof ConflictError;
  }

  /** The map re-read the note under a draft kept by a conflict: the same save now applies to it, and the line says so. */
  refreshed(): void {
    if (!this.conflicted) return;
    this.conflicted = false;
    this.element.setText(t().refreshed);
  }
}
