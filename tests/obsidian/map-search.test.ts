// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { MapSearchModal, listMapNotes, searchText } from '../../src/obsidian/map-search';

// The browser-harness stand-in for `obsidian`: FuzzySuggestModal over a real DOM, the metadata cache from the in-memory vault.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

const MAP = '---\nmappy: true\n---\n## Root\n- a\n';

/** A vault with maps at the top level and in folders, and the notes that must never be offered. */
function vault(): { app: HarnessApp; current: TFile } {
  const app = new HarnessApp();
  const current = app.put('Maps/current.md', MAP);
  app.put('Maps/講座の本体.md', MAP);
  app.put('Maps/Sub/timeline.md', '---\nmappy: true\nmappy-layout: timeline\n---\n## T\n');
  app.put('top-level.md', MAP);
  app.put('Maps/plain.md', '## Not a map\n');
  app.put('Maps/quoted.md', '---\nmappy: "true"\n---\n## Root\n');
  app.put('Maps/drawing.md', '---\nmappy: true\nexcalidraw-plugin: parsed\n---\n## Root\n');
  app.put('Maps/image.png', '', 'blob:image');
  return { app, current: current as unknown as TFile };
}

function open(app: HarnessApp, except: TFile | null): { modal: MapSearchModal; choose: ReturnType<typeof vi.fn>; items: () => HTMLElement[]; input: HTMLInputElement } {
  const choose = vi.fn();
  const modal = new MapSearchModal(app.asApp<App>(), except, choose);
  modal.open();
  const input = document.querySelector<HTMLInputElement>('.prompt-input');
  if (!input) throw new Error('The modal has no input');
  return { modal, choose, input, items: () => Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item')) };
}

/** The characters a line marks as matched, in order (the stand-in's fuzzy search matches greedily, so runs may split). */
function highlighted(item: HTMLElement | undefined, line: string): string {
  return Array.from(item?.querySelectorAll(`.${line} .suggestion-highlight`) ?? [], mark => mark.textContent ?? '').join('');
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('listMapNotes', () => {
  it('offers every other note with the boolean mappy: true, in path order', () => {
    const { app, current } = vault();
    expect(listMapNotes(app.asApp<App>(), current).map(file => file.path)).toEqual(['Maps/Sub/timeline.md', 'Maps/講座の本体.md', 'top-level.md']);
    expect(listMapNotes(app.asApp<App>(), null).map(file => file.path)).toContain('Maps/current.md');
  });

  it('reads the title after the folder, so a query can name either or folder/title', () => {
    const { app } = vault();
    const byPath = new Map(listMapNotes(app.asApp<App>(), null).map(file => [file.path, searchText(file)]));
    expect(byPath.get('Maps/Sub/timeline.md')).toBe('Maps/Sub/timeline');
    expect(byPath.get('top-level.md')).toBe('top-level');
  });
});

describe('MapSearchModal', () => {
  it('shows each candidate as its name over its folder, with the prompt and the key hints', () => {
    const { app, current } = vault();
    const { items, input } = open(app, current);
    expect(input.placeholder).toBe('マップを検索（タイトルとパス）');
    expect(items().map(item => item.querySelector('.suggestion-title')?.textContent)).toEqual(['timeline', '講座の本体', 'top-level']);
    expect(items().map(item => item.querySelector('.suggestion-note')?.textContent ?? null)).toEqual(['Maps/Sub', 'Maps', null]);
    expect(Array.from(document.querySelectorAll('.prompt-instruction'), hint => hint.textContent)).toEqual(['↑↓移動', '↵呼び出す', 'esc閉じる']);
    expect(document.querySelector('.suggestion-empty')).toBeNull();
  });

  it('says there are no maps when nothing but the current note qualifies', () => {
    const app = new HarnessApp();
    const current = app.put('only.md', MAP) as unknown as TFile;
    app.put('plain.md', '## Not a map\n');
    const { items } = open(app, current);
    expect(items()).toHaveLength(0);
    expect(document.querySelector('.suggestion-empty')?.textContent).toBe('マップがありません');
  });

  it('narrows by title and by folder, marking the matched characters where they show', () => {
    const { app, current } = vault();
    const { items, input } = open(app, current);
    type(input, '講座');
    expect(items().map(item => item.querySelector('.suggestion-title')?.textContent)).toEqual(['講座の本体']);
    expect(highlighted(items()[0], 'suggestion-title')).toBe('講座');
    expect(highlighted(items()[0], 'suggestion-note')).toBe('');
    type(input, 'sub/time');
    expect(items().map(item => item.querySelector('.suggestion-title')?.textContent)).toEqual(['timeline']);
    expect(highlighted(items()[0], 'suggestion-note')).toBe('sub');
    expect(highlighted(items()[0], 'suggestion-title')).toBe('time');
    type(input, 'nothing like this');
    expect(items()).toHaveLength(0);
    expect(document.querySelector('.suggestion-empty')?.textContent).toBe('マップがありません');
  });

  it('hands the chosen file back once and closes, by click and by Enter', () => {
    const { app, current } = vault();
    const first = open(app, current);
    first.items()[1]?.click();
    expect(first.choose).toHaveBeenCalledTimes(1);
    expect((first.choose.mock.calls[0]?.[0] as TFile).path).toBe('Maps/講座の本体.md');
    expect(document.querySelector('.modal')).toBeNull();
    const second = open(app, current);
    type(second.input, 'top');
    second.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(second.choose).toHaveBeenCalledTimes(1);
    expect((second.choose.mock.calls[0]?.[0] as TFile).path).toBe('top-level.md');
    expect(document.querySelector('.modal')).toBeNull();
  });
});
