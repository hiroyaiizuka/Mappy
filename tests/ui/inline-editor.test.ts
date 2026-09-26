// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { InlineEditor, type InlineEditorOptions } from '../../src/ui/inline-editor';

const editors = new Set<InlineEditor>();

afterEach(() => {
  for (const editor of editors) editor.dispose();
  editors.clear();
  document.body.replaceChildren();
});

/** Supply only the Obsidian DOM conveniences used by the actual editor. */
function createHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.addClass = (...classes) => { host.classList.add(...classes); };
  host.removeClass = (...classes) => { host.classList.remove(...classes); };
  host.createEl = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: DomElementInfo | string,
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    element.setText = (value) => { element.replaceChildren(value); };
    const info = typeof options === 'string' ? { cls: options } : options;
    if (info?.cls) element.classList.add(...(Array.isArray(info.cls) ? info.cls : info.cls.split(' ')));
    if (info?.text !== undefined) element.setText(info.text);
    for (const [name, value] of Object.entries(info?.attr ?? {})) {
      if (value !== null) element.setAttribute(name, String(value));
    }
    host.append(element);
    callback?.(element);
    return element;
  };
  host.createDiv = (options, callback) => host.createEl('div', options, callback);
  document.body.append(host);
  return host;
}

function fixture(initial = '元の名前', suggest?: InlineEditorOptions['suggest']) {
  const host = createHost();
  const options = {
    initial,
    save: vi.fn<InlineEditorOptions['save']>().mockResolvedValue(undefined),
    finish: vi.fn<InlineEditorOptions['finish']>(),
    resize: vi.fn<InlineEditorOptions['resize']>(),
    restore: vi.fn<InlineEditorOptions['restore']>(),
    ...(suggest ? { suggest } : {}),
  } satisfies InlineEditorOptions;
  const editor = new InlineEditor(host, options);
  editors.add(editor);
  const input = host.querySelector('textarea');
  const error = host.querySelector<HTMLDivElement>('[role="alert"]');
  if (!input || !error) throw new Error('Editor did not create its input and error UI');
  return { host, options, editor, input, error };
}

function key(target: EventTarget, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function pendingSave() {
  let resolve: () => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

describe('InlineEditor DOM interactions', () => {
  it('focuses the real textarea at the node and resizes on input', () => {
    const { host, options, input } = fixture('日本語');
    expect(host.classList.contains('is-editing')).toBe(true);
    expect(input.value).toBe('日本語');
    expect(input.getAttribute('aria-label')).toBe('ノードのテキスト');
    expect(input.hasAttribute('placeholder')).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    const calls = options.resize.mock.calls.length;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '追加' }));
    expect(options.resize).toHaveBeenCalledTimes(calls + 1);
    expect(options.save).not.toHaveBeenCalled();
  });

  it('gives an emptied draft the empty node\'s box, and takes it away with the text or the editor (LEV-203)', () => {
    const { host, input, editor } = fixture('');
    expect(host.classList.contains('is-draft-empty')).toBe(true);
    input.value = 'あ';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'あ' }));
    expect(host.classList.contains('is-draft-empty')).toBe(false);
    input.value = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(host.classList.contains('is-draft-empty')).toBe(true);
    editor.dispose();
    expect(host.classList.contains('is-draft-empty')).toBe(false);
    expect(fixture('名前').host.classList.contains('is-draft-empty')).toBe(false);
  });

  describe('the draft box (LEV-198)', () => {
    /** Whether the page reports `field-sizing: content` as supported. */
    const fieldSizing = (supported: boolean): void => {
      vi.stubGlobal('CSS', { supports: (property: string, value: string) => supported && property === 'field-sizing' && value === 'content' });
      onTestFinished(() => { vi.unstubAllGlobals(); });
    };
    /** jsdom has no layout: scrollWidth reads `read(textarea)` instead. */
    const scrollWidth = (read: (input: HTMLTextAreaElement) => number): void => {
      const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLTextAreaElement) { return read(this); });
      onTestFinished(() => { spy.mockRestore(); });
    };

    it('leaves the box to the stylesheet where it sizes the textarea to its text, measuring nothing', () => {
      fieldSizing(true);
      const reads: string[] = [];
      scrollWidth(input => { reads.push(input.className); return 180; });
      const { options, input } = fixture('長い名前');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '追加' }));
      expect(reads).toEqual([]);
      expect(input.style.width).toBe('');
      expect(input.style.height).toBe('');
      expect(input.hasAttribute('cols')).toBe(false);
      // The map still lays out for the node's new size on every input.
      expect(options.resize).toHaveBeenCalledTimes(2);
    });

    it('otherwise sizes the draft to its text measured on one row, leaving the wrap to the CSS max-width', () => {
      fieldSizing(false);
      // 180px for the text laid out on one row (the `is-measuring` rule in styles.css: no width, no wrapping), 40px otherwise.
      const measured: string[] = [];
      scrollWidth(input => {
        const measuring = input.classList.contains('is-measuring');
        measured.push(`${measuring ? 'one row' : 'wrapped'} ${input.style.width || 'css'}`);
        return measuring ? 180 : 40;
      });
      const { input } = fixture('長い名前');
      expect(measured).toEqual(['one row css']);
      expect(input.style.width).toBe('182px');
      expect(input.classList.contains('is-measuring')).toBe(false);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '追加' }));
      // The width set last time is cleared first, or it would outrank the class's `width: 0`.
      expect(measured).toEqual(['one row css', 'one row css']);
    });

    it('measures again on fit: a node restyled under the draft, or a pane that had no layout when it opened', () => {
      fieldSizing(false);
      let width = 0;
      scrollWidth(() => width);
      const { options, editor, input } = fixture('長い名前');
      // A hidden pane: nothing to measure, so no width is pinned.
      expect(input.style.width).toBe('');
      width = 180;
      const calls = options.resize.mock.calls.length;
      editor.fit();
      expect(input.style.width).toBe('182px');
      // The callers (draw, onResize) lay the map out themselves.
      expect(options.resize).toHaveBeenCalledTimes(calls);
      // The node became a root (bolder, wider text).
      width = 200;
      editor.fit();
      expect(input.style.width).toBe('202px');
    });

    it('does nothing on fit where the stylesheet sizes the draft', () => {
      fieldSizing(true);
      const reads: number[] = [];
      scrollWidth(() => { reads.push(1); return 180; });
      const { options, editor, input } = fixture('長い名前');
      const calls = options.resize.mock.calls.length;
      editor.fit();
      expect(reads).toEqual([]);
      expect(input.style.width).toBe('');
      expect(options.resize).toHaveBeenCalledTimes(calls);
    });

    it('widens with the text while the IME composes, as the stylesheet path does', () => {
      fieldSizing(false);
      let width = 100;
      scrollWidth(() => width);
      const { input } = fixture('');
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      // Kana typed before the conversion is confirmed: the draft stays one row and widens, not a 40px column.
      width = 160;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'へんかん' }));
      expect(input.style.width).toBe('162px');
      input.dispatchEvent(new CompositionEvent('compositionend'));
      expect(input.style.width).toBe('162px');
    });

    it('keeps the measured box when the pane loses its layout, and measures on a resize only when never measured', () => {
      fieldSizing(false);
      let width = 180;
      const reads: number[] = [];
      scrollWidth(() => { reads.push(width); return width; });
      const { editor, input } = fixture('長い名前');
      expect(input.style.width).toBe('182px');
      const height = input.style.height;
      // Hidden (a redraw while another tab is in front): nothing readable, so the width and height stay.
      width = 0;
      editor.fit();
      expect(input.style.width).toBe('182px');
      expect(input.style.height).toBe(height);
      // A resize of a draft already measured reads nothing.
      reads.length = 0;
      width = 180;
      editor.fit(true);
      expect(reads).toEqual([]);
    });
  });

  it.each(['Enter', 'Tab', 'Escape'])('lets suggestions consume %s without finishing the node', value => {
    const suggestion = { handleKey: vi.fn(() => true), dispose: vi.fn() };
    const { options, editor, input } = fixture('[[', () => suggestion);
    key(input, value);
    expect(suggestion.handleKey).toHaveBeenCalledTimes(1);
    expect(options.save).not.toHaveBeenCalled();
    expect(options.finish).not.toHaveBeenCalled();
    editor.dispose();
    expect(suggestion.dispose).toHaveBeenCalledTimes(1);
  });

  it('never lets suggestions consume composition confirmation', () => {
    const suggestion = { handleKey: vi.fn(() => true), dispose: vi.fn() };
    const { options, input } = fixture('[[', () => suggestion);
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    key(input, 'Enter');
    expect(suggestion.handleKey).not.toHaveBeenCalled();
    expect(options.save).not.toHaveBeenCalled();
  });

  it.each(['新しい日本語の名前', ''])('saves %j on Enter and finishes only after save succeeds', async (draft) => {
    const { host, options, input } = fixture();
    const pending = pendingSave();
    options.save.mockReturnValue(pending.promise);
    input.value = draft;
    expect(key(input, 'Enter').defaultPrevented).toBe(true);
    expect(options.save).toHaveBeenCalledExactlyOnceWith(draft);
    expect(input.readOnly).toBe(true);
    expect(options.finish).not.toHaveBeenCalled();
    expect(options.restore).not.toHaveBeenCalled();
    pending.resolve();
    await pending.promise;
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('none', false);
    expect(options.restore).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.classList.contains('is-editing')).toBe(false);
  });

  it('saves on Tab before requesting a child node', async () => {
    const { options, input } = fixture('親ノード');
    const pending = pendingSave();
    options.save.mockReturnValue(pending.promise);
    expect(key(input, 'Tab').defaultPrevented).toBe(true);
    expect(options.save).toHaveBeenCalledExactlyOnceWith('親ノード');
    expect(options.finish).not.toHaveBeenCalled();
    pending.resolve();
    await pending.promise;
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('child', false);
    expect(options.restore).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape without saving and restores the host only once', () => {
    const { host, options, editor, input } = fixture();
    input.value = '保存しない下書き';
    expect(key(input, 'Escape').defaultPrevented).toBe(true);
    expect(options.save).not.toHaveBeenCalled();
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('none', true);
    expect(options.restore).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')).toBeNull();
    editor.dispose();
    expect(options.restore).toHaveBeenCalledTimes(1);
  });

  it('leaves Shift+Enter to the textarea, which breaks the line inside the node (LEV-202)', async () => {
    const { options, input } = fixture('温泉旅行');
    expect(key(input, 'Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    await Promise.resolve();
    expect(options.save).not.toHaveBeenCalled();
    // The break the textarea inserts is saved with the rest on Enter.
    input.value = '温泉\n旅行';
    expect(key(input, 'Enter').defaultPrevented).toBe(true);
    expect(options.save).toHaveBeenCalledExactlyOnceWith('温泉\n旅行');
  });

  it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }])('still confirms on Shift+Enter with %o, as on Enter', (modifier) => {
    // Pins that only the plain Shift+Enter breaks the line; these confirmed before LEV-202 as well.
    const { options, input } = fixture();
    expect(key(input, 'Enter', { shiftKey: true, ...modifier }).defaultPrevented).toBe(true);
    expect(options.save).toHaveBeenCalledOnce();
  });

  it('suppresses Enter during composition and saves after compositionend', async () => {
    const { options, input } = fixture();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '変換中';
    expect(key(input, 'Enter').defaultPrevented).toBe(false);
    expect(options.save).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));
    input.value = '日本語';
    expect(key(input, 'Enter').defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(options.save).toHaveBeenCalledExactlyOnceWith('日本語');
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('none', false);
  });

  it('waits for compositionend and the final input before saving after blur', async () => {
    const { options, input } = fixture();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '変換とちゅう';
    input.blur();
    expect(options.save).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '途中' }));
    input.value = '変換途中';
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(options.save).toHaveBeenCalledExactlyOnceWith('変換途中');
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('none', false);
  });

  it('does not save a composition blur if focus returns before completion', async () => {
    const { options, input } = fixture();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.blur();
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionend'));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(options.save).not.toHaveBeenCalled();
    expect(options.finish).not.toHaveBeenCalled();
  });

  it('does not save after disposal during a pending composition blur', async () => {
    const { options, editor, input } = fixture();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.blur();
    input.dispatchEvent(new CompositionEvent('compositionend'));
    editor.dispose();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(options.save).not.toHaveBeenCalled();
    expect(options.finish).not.toHaveBeenCalled();
  });

  it.each([{ key: 'Enter', isComposing: true }, { key: 'Process', isComposing: false }])(
    'does not commit an IME keyboard event %j', (event) => {
      const { options, input } = fixture();
      expect(key(input, event.key, { isComposing: event.isComposing }).defaultPrevented).toBe(false);
      expect(options.save).not.toHaveBeenCalled();
      expect(options.finish).not.toHaveBeenCalled();
    },
  );

  it('keeps a rejected draft editable and visible, avoids blur retries, and allows an explicit retry', async () => {
    const { host, options, input, error } = fixture();
    options.save.mockRejectedValueOnce(new Error('外部変更との競合')).mockResolvedValueOnce(undefined);
    input.value = '消してはいけない下書き';
    key(input, 'Enter');
    await Promise.resolve();
    expect(input.value).toBe('消してはいけない下書き');
    expect(error.textContent).toBe('外部変更との競合');
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(host.classList.contains('is-editing')).toBe(true);
    expect(options.finish).not.toHaveBeenCalled();
    expect(options.restore).not.toHaveBeenCalled();
    input.dispatchEvent(new FocusEvent('blur'));
    await Promise.resolve();
    expect(options.save).toHaveBeenCalledTimes(1);
    input.value = '修正して再試行';
    key(input, 'Enter');
    await Promise.resolve();
    expect(options.save).toHaveBeenNthCalledWith(2, '修正して再試行');
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('none', false);
    expect(options.restore).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('prevents duplicate saves from Enter, Tab, and blur while a save is pending', async () => {
    const { options, input } = fixture();
    const pending = pendingSave();
    options.save.mockReturnValue(pending.promise);
    key(input, 'Enter');
    key(input, 'Tab');
    input.dispatchEvent(new FocusEvent('blur'));
    expect(options.save).toHaveBeenCalledTimes(1);
    pending.resolve();
    await pending.promise;
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('none', false);
    expect(options.restore).toHaveBeenCalledTimes(1);
  });

  it('commits once when the input loses focus without a previous error', async () => {
    const { options, input } = fixture('フォーカス移動');
    input.dispatchEvent(new FocusEvent('blur'));
    await Promise.resolve();
    expect(options.save).toHaveBeenCalledExactlyOnceWith('フォーカス移動');
    expect(options.finish).toHaveBeenCalledExactlyOnceWith('none', false);
  });

  it('does not emit finish when a disposed editor later completes a pending save', async () => {
    const { host, options, editor, input } = fixture();
    const pending = pendingSave();
    options.save.mockReturnValue(pending.promise);
    key(input, 'Tab');
    editor.dispose();
    editor.dispose();
    expect(options.restore).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')).toBeNull();
    pending.resolve();
    await pending.promise;
    expect(options.finish).not.toHaveBeenCalled();
    expect(options.restore).toHaveBeenCalledTimes(1);
  });

  it('does not restore a disposed draft or steal focus when its pending save fails', async () => {
    const { host, options, editor, input, error } = fixture();
    const pending = pendingSave();
    options.save.mockReturnValue(pending.promise);
    key(input, 'Enter');
    editor.dispose();
    const nextInput = document.createElement('input');
    document.body.append(nextInput);
    nextInput.focus();
    pending.reject(new Error('遅れて発生したエラー'));
    await pending.promise.catch(() => undefined);
    expect(document.activeElement).toBe(nextInput);
    expect(error.textContent).toBe('');
    expect(host.querySelector('textarea')).toBeNull();
    expect(options.finish).not.toHaveBeenCalled();
    expect(options.restore).toHaveBeenCalledTimes(1);
  });

  it('keeps node-level keyboard and pointer handlers from firing during text editing', () => {
    const { host, input } = fixture();
    const onKey = vi.fn();
    const onPointer = vi.fn();
    const onClick = vi.fn();
    host.addEventListener('keydown', onKey);
    host.addEventListener('pointerdown', onPointer);
    host.addEventListener('click', onClick);
    host.addEventListener('dblclick', onClick);
    key(input, 'ArrowLeft');
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onKey).not.toHaveBeenCalled();
    expect(onPointer).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });
});
