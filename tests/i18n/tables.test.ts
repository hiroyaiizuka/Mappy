import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/en';
import { ja } from '../../src/i18n/ja';
import { messagesFor, setLanguage, t } from '../../src/i18n';

/** Kana, CJK and full-width forms: text that has no business in the English table. */
const JAPANESE = /[　-鿿＀-￯]/u;

describe('the text tables (architecture.md §9e)', () => {
  afterEach(() => { setLanguage('ja'); });

  it('pick Japanese for ja only; every other language, and none, is English', () => {
    expect(messagesFor('ja')).toBe(ja);
    for (const language of ['en', 'de', 'zh', 'ja-JP', 'JA', '']) expect(messagesFor(language)).toBe(en);
    setLanguage('en');
    expect(t()).toBe(en);
    setLanguage('ja');
    expect(t()).toBe(ja);
  });

  it('have the same keys, each with the same kind of value', () => {
    // The `Messages` type already refuses a missing or extra key in ja.ts; this pins the same at run time.
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect([key, typeof ja[key]]).toEqual([key, typeof en[key]]);
    }
  });

  it('English has no Japanese left in it, and Japanese is not a copy of the English', () => {
    for (const [key, value] of Object.entries(en)) {
      const text = typeof value === 'function' ? (value as (...args: string[]) => string)('A', 'B', 'C') : value;
      expect([key, JAPANESE.test(text)]).toEqual([key, false]);
      expect([key, text.trim().length > 0]).toEqual([key, true]);
    }
    for (const [key, value] of Object.entries(ja)) {
      if (typeof value === 'string' && !JAPANESE.test(value)) expect([key, value]).toEqual([key, en[key as keyof typeof en]]);
    }
  });

  it('text with values spliced in takes the same arguments in both languages and shows every one of them', () => {
    // lint does not look inside functions, and the type only checks the parameters: this checks a translation
    // did not drop or repeat the wrong value.
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const english: unknown = en[key];
      const japanese: unknown = ja[key];
      if (typeof english !== 'function' || typeof japanese !== 'function') continue;
      expect([key, japanese.length]).toEqual([key, english.length]);
      const args = Array.from({ length: english.length }, (_, index) => `«arg${index}»`);
      for (const text of [(english as (...a: string[]) => string)(...args), (japanese as (...a: string[]) => string)(...args)]) {
        for (const arg of args) expect([key, text.includes(arg)]).toEqual([key, true]);
      }
    }
  });
});
