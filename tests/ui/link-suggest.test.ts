// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { LinkSuggest } from '../../src/ui/link-suggest';
import { InlineEditor, type InlineEditorOptions } from '../../src/ui/inline-editor';

const suggestions = new Set<LinkSuggest>();
const editors = new Set<InlineEditor>();
let originalCreateDiv: PropertyDescriptor | undefined;

function domHelpers(element: HTMLElement): void {
  element.addClass = (...classes) => { element.classList.add(...classes); };
  element.removeClass = (...classes) => { element.classList.remove(...classes); };
  element.setText = value => { element.replaceChildren(value); };
  element.createEl = <K extends keyof HTMLElementTagNameMap>(
    tag: K, options?: DomElementInfo | string, callback?: (child: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] => {
    const child = document.createElement(tag);
    domHelpers(child);
    const info = typeof options === 'string' ? { cls: options } : options;
    if (info?.cls) child.classList.add(...(Array.isArray(info.cls) ? info.cls : info.cls.split(' ')));
    for (const [name, value] of Object.entries(info?.attr ?? {})) {
      if (value !== null) child.setAttribute(name, String(value));
    }
    element.append(child);
    callback?.(child);
    return child;
  };
  element.createDiv = (options, callback) => element.createEl('div', options, callback);
  element.createSpan = (options, callback) => element.createEl('span', options, callback);
  element.scrollIntoView = vi.fn();
}

beforeEach(() => {
  originalCreateDiv = Object.getOwnPropertyDescriptor(document.body, 'createDiv');
  document.body.createDiv = () => {
    const child = document.createElement('div');
    domHelpers(child);
    document.body.append(child);
    return child;
  };
});

afterEach(() => {
  for (const editor of editors) editor.dispose();
  editors.clear();
  for (const suggest of suggestions) suggest.dispose();
  suggestions.clear();
  document.body.replaceChildren();
  if (originalCreateDiv) Object.defineProperty(document.body, 'createDiv', originalCreateDiv);
  else Reflect.deleteProperty(document.body, 'createDiv');
});

function fixture() {
  const files = [
    { basename: '睡眠', name: '睡眠.md', extension: 'md', path: '健康/睡眠.md' },
    { basename: '睡眠', name: '睡眠.md', extension: 'md', path: '仕事/睡眠.md' },
    { basename: '運動', name: '運動.md', extension: 'md', path: '運動.md' },
    { basename: '図', name: '図.png', extension: 'png', path: '画像/図.png' },
    { basename: '図', name: '図.png', extension: 'png', path: '資料/図.png' },
    { basename: '構成 図', name: '構成 図.svg', extension: 'svg', path: '画像/構成 図.svg' },
    { basename: '講座', name: '講座.pdf', extension: 'pdf', path: '資料/講座.pdf' },
  ] as TFile[];
  const fileToLinktext = vi.fn((file: TFile) => file.extension === 'md' ? file.path.slice(0, -3) : file.path);
  const app = {
    vault: { getMarkdownFiles: () => files.filter(file => file.extension === 'md'), getFiles: () => files },
    metadataCache: {
      fileToLinktext,
      getFileCache: (file: TFile) => ({ frontmatter: { aliases: file.path === '健康/睡眠.md' ? ['ねむり'] : [] } }),
    },
  } as unknown as App;
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  const suggest = new LinkSuggest(app, input, '講座/原稿.md');
  suggestions.add(suggest);
  const key = (value: string, init: KeyboardEventInit = {}): boolean => suggest.handleKey(new KeyboardEvent('keydown', { key: value, cancelable: true, ...init }));
  const type = (value: string, cursor = value.length): void => {
    input.value = value;
    input.setSelectionRange(cursor, cursor);
    input.dispatchEvent(new Event('input'));
  };
  return { input, suggest, key, type, fileToLinktext, app };
}

function integratedFixture() {
  const { app, input: unusedInput, suggest: unusedSuggest } = fixture();
  unusedSuggest.dispose();
  unusedInput.remove();
  const host = document.body.createDiv();
  const save = vi.fn<InlineEditorOptions['save']>().mockResolvedValue(undefined);
  const finish = vi.fn<InlineEditorOptions['finish']>();
  const editor = new InlineEditor(host, {
    initial: '', save, finish, restore: vi.fn(), resize: vi.fn(),
    suggest: input => new LinkSuggest(app, input, '講座/原稿.md'),
  });
  editors.add(editor);
  const input = host.querySelector('textarea');
  if (!input) throw new Error('Editor input was not created');
  return { input, save, finish };
}

describe('node wikilink suggestions', () => {
  it.each(['Enter', 'Tab'])('actual InlineEditor lets %s complete a link, then separately save', async value => {
    const { input, save, finish } = integratedFixture();
    input.value = '前 [[運';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: value, cancelable: true, bubbles: true }));
    await Promise.resolve();
    expect(input.value).toBe('前 [[運動]]');
    expect(save).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }));
    await Promise.resolve();
    expect(save).toHaveBeenCalledExactlyOnceWith('前 [[運動]]');
    expect(finish).toHaveBeenCalledExactlyOnceWith('none', false);
  });

  it('actual InlineEditor keeps candidate mouse selection within the draft', async () => {
    const { input, save, finish } = integratedFixture();
    input.value = '[[ねむ';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const option = document.querySelector<HTMLElement>('[role="option"]');
    if (!option) throw new Error('No alias option');
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    option.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);
    option.click();
    await Promise.resolve();
    expect(input.value).toBe('[[健康/睡眠|ねむり]]');
    expect(save).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
  it('offers vault notes after [[, with paths distinguishing duplicate names', () => {
    const { type, input } = fixture();
    type('[[');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(8);
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('健康/睡眠.md');
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('仕事/睡眠.md');
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('includes PNG files with extension labels and disambiguates duplicate paths', () => {
    const { type, input } = fixture();
    type('前 [[図.p');
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options).toHaveLength(2);
    expect(options.map(option => option.querySelector('.mappy-link-title')?.textContent)).toEqual(['図.png', '図.png']);
    const image = options.find(option => option.textContent?.includes('画像/図.png'));
    expect(image).toBeDefined();
    image?.click();
    expect(input.value).toBe('前 [[画像/図.png]]');
  });

  it.each(['', '!'])('inserts an SVG with the original %s prefix and existing closing brackets', prefix => {
    const { type, input, key, fileToLinktext } = fixture();
    const text = `前 ${prefix}[[構成]] 後`;
    type(text, 6 + prefix.length);
    expect(key('Enter')).toBe(true);
    expect(input.value).toBe(`前 ${prefix}[[画像/構成 図.svg]] 後`);
    expect(fileToLinktext).toHaveBeenCalledWith(expect.objectContaining({ path: '画像/構成 図.svg' }), '講座/原稿.md', true);
  });

  it('offers PDF files as ordinary links without adding an embed marker', () => {
    const { type, key, input } = fixture();
    type('[[講座.p');
    expect(key('Tab')).toBe(true);
    expect(input.value).toBe('[[資料/講座.pdf]]');
  });

  it.each(['Enter', 'Tab'])('inserts a note with %s and preserves prefix, suffix and source-relative link resolution', keyName => {
    const { type, key, input, fileToLinktext } = fixture();
    type('前 [[運]] 後', 5);
    expect(key(keyName)).toBe(true);
    expect(input.value).toBe('前 [[運動]] 後');
    expect(input.selectionStart).toBe(8);
    expect(fileToLinktext).toHaveBeenCalledWith(expect.objectContaining({ path: '運動.md' }), '講座/原稿.md', true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(key(keyName)).toBe(false);
  });

  it('searches aliases and inserts a display alias', () => {
    const { type, key, input } = fixture();
    type('[[ねむ');
    expect(document.querySelector('[role="option"]')?.textContent).toContain('ねむり');
    key('Enter');
    expect(input.value).toBe('[[健康/睡眠|ねむり]]');
  });

  it('moves selection with arrows and lets Escape close only the list', () => {
    const { type, key, input } = fixture();
    type('[[睡');
    const first = input.getAttribute('aria-activedescendant');
    expect(key('ArrowDown')).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).not.toBe(first);
    expect(key('ArrowUp')).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe(first);
    expect(key('Escape')).toBe(true);
    expect(input.value).toBe('[[睡');
    expect(key('Escape')).toBe(false);
  });

  it('does not accept Enter while the IME is composing and resumes after compositionend', () => {
    const { type, key, input } = fixture();
    type('[[睡');
    expect(key('Enter', { isComposing: true })).toBe(false);
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    type('[[ねむ');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(key('Enter')).toBe(false);
    input.dispatchEvent(new CompositionEvent('compositionend'));
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(key('Enter')).toBe(true);
    expect(input.value).toBe('[[健康/睡眠|ねむり]]');
  });

  it('keeps input focus on mouse selection and inserts without a blur', () => {
    const { type, input } = fixture();
    type('[[運');
    const onBlur = vi.fn();
    input.addEventListener('blur', onBlur);
    const option = document.querySelector<HTMLElement>('[role="option"]');
    if (!option) throw new Error('Suggestion was not shown');
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    option.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    option.click();
    expect(input.value).toBe('[[運動]]');
    expect(onBlur).not.toHaveBeenCalled();
  });

  it('removes stale candidates when the query has no matches or the cursor leaves the link', () => {
    const { type, key, input } = fixture();
    type('[[睡');
    type('[[no such note');
    expect(key('Enter')).toBe(false);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    type('prefix [[睡');
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home' }));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes on map movement and removes listeners and the popup on dispose', () => {
    const { type, suggest, input } = fixture();
    type('[[');
    document.dispatchEvent(new WheelEvent('wheel'));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    type('[[');
    suggest.dispose();
    suggest.dispose();
    type('[[睡');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(input.hasAttribute('aria-expanded')).toBe(false);
  });
});
