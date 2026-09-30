// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { EditModal } from '../../src/ui/edit-modal';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

function open(multiline: boolean) {
  const submit = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  new EditModal({} as App, '本文', '本文を編集', multiline, submit).open();
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('.mappy-edit-input');
  if (!input) throw new Error('The modal has no input');
  return { input, submit };
}

function key(target: EventTarget, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

// E01 A1・A3 (LEV-223, review 3): the body's editor has the same composing keys as the node's draft. An Enter the IME
// lets through types a line break into the reading, and a Tab moves the focus to the buttons mid-composition; one the
// IME took (keyCode 229) is prevented as well, as in InlineEditor.
describe('EditModal while the IME composes', () => {
  it.each([
    { name: 'Enter let through', value: 'Enter', keyCode: 13, multiline: true },
    { name: 'Enter taken by the IME', value: 'Enter', keyCode: 229, multiline: true },
    { name: 'Tab let through', value: 'Tab', keyCode: 9, multiline: true },
    { name: 'Enter let through, one line', value: 'Enter', keyCode: 13, multiline: false },
  ])('stops the default of an $name, and saves nothing', ({ value, keyCode, multiline }) => {
    const { input, submit } = open(multiline);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(key(input, value, { isComposing: true, keyCode }).defaultPrevented).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('leaves Tab and Enter alone once the composition is over', () => {
    const { input, submit } = open(true);
    // A line break in the body, and Tab to the buttons: the textarea's own.
    expect(key(input, 'Enter').defaultPrevented).toBe(false);
    expect(key(input, 'Tab').defaultPrevented).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
