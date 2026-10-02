import { en, type Messages } from "./en";
import { ja } from "./ja";

export type { Messages } from "./en";

/**
 * The table for Obsidian's app language (`getLanguage()`): Japanese for `ja`, English for everything else.
 * Obsidian reloads the app when its language changes, so the choice is made once per load.
 */
export function messagesFor(language: string): Messages {
  return language === "ja" ? ja : en;
}

let current: Messages = en;

/**
 * Picks the language. `main.ts` calls it first thing in `onload` with `getLanguage()`; the tests and the
 * browser harness, which never run `onload`, call it themselves. Core does not call Obsidian, so it only reads.
 */
export function setLanguage(language: string): void {
  current = messagesFor(language);
}

/**
 * The locale to format dates and numbers in: Japanese with the Japanese table, the OS's otherwise (English is the
 * table for every other language, so the OS's locale is the closer guess there).
 */
export function textLocale(): string | undefined {
  return current === ja ? "ja-JP" : undefined;
}

/**
 * The current table. Read it where the text is used, never into a module-level constant: modules load before
 * `onload` sets the language, so a copy taken then stays English (tests/i18n/load-time.test.ts checks this).
 */
export function t(): Messages {
  return current;
}
