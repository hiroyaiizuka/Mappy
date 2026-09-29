import { t } from '../i18n';

/**
 * A write refused because the note moved under it (another app, another tab, a change the view had not read yet).
 * The map view re-reads the note on it and a kept draft's line changes to say so; they tell it by this class, never
 * by its text, which follows the app's language (architecture.md §9e). It lives apart from the store, which throws
 * it, so the draft widgets (src/ui/refusal-line.ts) can tell it without loading the store.
 */
export class ConflictError extends Error {
  /**
   * Set by the map view when, by the time the write was refused, the map already showed a newer note than the one the
   * write was planned on (a re-read published it while the write ran, LEV-252): the draft's line says the retry line
   * at once, as no later re-read changes the map to say it.
   */
  caughtUp = false;

  constructor() {
    super(t().conflict);
    this.name = 'ConflictError';
  }
}

