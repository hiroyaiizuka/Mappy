/**
 * Characters of Japanese text (kana, CJK, full-width forms): what the English UI must not show. Shared by E63
 * (english-ui.mjs, on the real Obsidian) and tests/i18n/tables.test.ts (the English table), so both mean the same.
 */
export const JAPANESE = /[\u3000-\u9fff\uff00-\uffef]/u;
