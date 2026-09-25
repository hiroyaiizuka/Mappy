// @vitest-environment jsdom
/**
 * One user action — pasting an image onto a node — against every shape of node it can land on, because
 * that is how this broke twice: the note is written, the map re-reads it, and whatever the map was
 * holding by id (the open draft, the selection, the folds) must still be on the same node afterwards.
 *
 * The cases are the shapes of the node pasted onto, not the shape of the bug that was reported: a node
 * whose title is empty is the one an image is pasted onto most often (pasting leaves the title empty),
 * and every such node is "same-named" as far as a re-parse matching by title is concerned. LEV-142 was
 * fixed for repeated titles and shipped in 0.3.1, and the same failure came back for empty ones in 0.3.2
 * (LEV-146); this file is the matrix that would have caught both.
 *
 * Three of these fail on 0.3.2 (`artifacts/lev-146-same-name-ids/tests-before-fix.log`): the second
 * untitled node, the selection and the folds. The rest hold there too and are kept as the shapes of the
 * same action that must go on working — the one node, the repeated title, the untitled node renamed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { accessibleName } from './accessible-name';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer, store and modals run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/paste.md';
const EMPTY_LABEL = '空のノード';

/** A plain map: unique titles, one branch with children. */
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 講座の構成', '',
  '- はじめに', '  - 学ぶこと', '  - 全体の流れ',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');

/** The same map after one image was pasted: the node that took it has no title, as pasting leaves it. */
const AFTER_ONE_PASTE = [
  '---', 'mappy: true', '---',
  '## 講座の構成', '',
  '- はじめに', '  - 学ぶこと', '  - 全体の流れ',
  '- ', '',
  '  ![[0-first.png]]',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');

/** Two branches of one name, each with a body and a child: the LEV-142 shape. */
const SAME_NAMED = [
  '---', 'mappy: true', '---',
  '## 講座の構成', '',
  '- 同じ名前', '  一つ目の本文', '  - 一つ目の子',
  '- 同じ名前', '  二つ目の本文', '  - 二つ目の子', '',
].join('\n');

/** The clipboard as Obsidian delivers it: the image arrives as a file, not as text. */
function pasteImage(target: EventTarget, name = 'shot.png'): void {
  const image = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [image] } });
  target.dispatchEvent(paste);
}

async function mount(source: string): Promise<MountedMapView> {
  const mounted = await mountMapView(PATH, source);
  opened.push(mounted);
  return mounted;
}

function errorLine(mounted: MountedMapView): string {
  return mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '';
}

/** Every node on screen with this label; an empty node reads as 空のノード, so there can be several. */
function nodes(mounted: MountedMapView, label: string): HTMLElement[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'))
    .filter(item => accessibleName(item) === label);
}

function folds(mounted: MountedMapView): ReadonlySet<string> {
  const collapsed = mounted.view.snapshot()?.collapsed;
  if (!collapsed) throw new Error('The view has no snapshot');
  return collapsed;
}

/** Let the attachment be written and the map re-read it, as a paste does. */
async function pasted(mounted: MountedMapView, target: EventTarget, name?: string): Promise<void> {
  pasteImage(target, name);
  await mounted.settle();
  await mounted.settle();
}

describe('pasting an image onto a node while its text is being edited', () => {
  it('writes the image and then the title, on a node the map just made (its title still empty)', async () => {
    const mounted = await mount(SOURCE);
    const { select, key, node, settle, editor, source } = mounted;
    select('はじめに');
    key(node('はじめに'), 'Tab');
    await settle();
    const input = editor();
    if (!input) throw new Error('Tab did not open the inline editor');
    await pasted(mounted, input);
    expect(source()).toContain('![[1-shot.png]]');
    expect(errorLine(mounted)).toBe('');
    input.value = '新しい子';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    await settle();
    expect(errorLine(mounted)).toBe('');
    expect(editor()).toBeNull();
    expect(source()).toContain('- 新しい子');
    expect(source()).toContain('![[1-shot.png]]');
  });

  it('does the same on the second such node, with the first still untitled beside it', async () => {
    // What the user reported on 0.3.2: the first paste leaves a node with no title, so the next one is
    // pasted onto a map that already holds one. Matched by title, the two are the same node, and every
    // write renumbered both — the draft then lost its node and Enter answered 「…見つかりません」 (LEV-146).
    const mounted = await mount(AFTER_ONE_PASTE);
    const { select, key, node, settle, editor, source } = mounted;
    select('記録する');
    key(node('記録する'), 'Tab');
    await settle();
    const input = editor();
    if (!input) throw new Error('Tab did not open the inline editor');
    await pasted(mounted, input, 'second.png');
    expect(source()).toContain('![[1-second.png]]');
    expect(errorLine(mounted)).toBe('');
    input.value = '二つ目';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    await settle();
    expect(errorLine(mounted)).toBe('');
    expect(editor()).toBeNull();
    expect(source()).toContain('- 二つ目');
    expect(source()).toContain('![[0-first.png]]');
    expect(source()).toContain('![[1-second.png]]');
  });

  it('keeps the draft on an untitled node that is being renamed among other untitled ones', async () => {
    const two = AFTER_ONE_PASTE.replace('- 記録する', '- \n\n  ![[0-second.png]]\n- 記録する');
    const mounted = await mount(two);
    const { key, settle, editor, source } = mounted;
    const [, second] = nodes(mounted, EMPTY_LABEL);
    if (!second) throw new Error('The map should show two empty nodes');
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(second, 'F2');
    await settle();
    const input = editor();
    if (!input) throw new Error('F2 did not open the inline editor');
    await pasted(mounted, input, 'third.png');
    input.value = '二枚目の話';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    await settle();
    expect(errorLine(mounted)).toBe('');
    // The title landed on the node that was being edited: the one holding the second and third images.
    expect(source()).toContain('- 二枚目の話\n\n  ![[0-second.png]]\n\n  ![[1-third.png]]');
  });

  it('keeps the draft on a node whose title another node shares', async () => {
    const mounted = await mount(SAME_NAMED);
    const { key, settle, editor, source } = mounted;
    const [first] = nodes(mounted, '同じ名前');
    if (!first) throw new Error('The map should show the same-named branches');
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(first, 'F2');
    await settle();
    const input = editor();
    if (!input) throw new Error('F2 did not open the inline editor');
    await pasted(mounted, input);
    input.value = '一つ目（編集）';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    await settle();
    expect(errorLine(mounted)).toBe('');
    expect(source()).toContain('- 一つ目（編集）\n  一つ目の本文\n\n  ![[1-shot.png]]');
    expect(source()).toContain('- 同じ名前\n  二つ目の本文');
  });
});

describe('what the map shows the moment an image is pasted', () => {
  it('draws the image on the node while its text is still being edited', async () => {
    // The node shows the inline editor in place of its text while a draft is open, and its whole content
    // used to be hidden with it — so an image pasted during the edit appeared only after Enter or Escape,
    // and the user waits in front of a node that looks unchanged (報告: 2026-09-22).
    const mounted = await mount(SOURCE);
    const { select, key, node, settle, editor } = mounted;
    select('学ぶこと');
    key(node('学ぶこと'), 'F2');
    await settle();
    const input = editor();
    if (!input) throw new Error('F2 did not open the inline editor');
    const element = node('学ぶこと');
    await pasted(mounted, input);
    const content = element.querySelector<HTMLElement>('.mappy-node-content');
    expect(content?.hidden).toBe(false);
    expect(element.querySelectorAll('.mappy-node-attachments .image-embed')).toHaveLength(1);
    // The text is the draft's business while the editor is open: the node does not show it twice.
    expect(element.querySelector<HTMLElement>('.mappy-node-label')?.hidden).toBe(true);
    expect(editor()).toBe(input);
  });

  it('keeps showing it once the draft is confirmed', async () => {
    const mounted = await mount(SOURCE);
    const { select, key, node, settle, editor, source } = mounted;
    select('学ぶこと');
    key(node('学ぶこと'), 'F2');
    await settle();
    const input = editor();
    if (!input) throw new Error('F2 did not open the inline editor');
    await pasted(mounted, input);
    input.value = '学ぶこと（編集）';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    await settle();
    expect(errorLine(mounted)).toBe('');
    expect(source()).toContain('![[1-shot.png]]');
    const element = node('学ぶこと（編集）');
    expect(element.querySelectorAll('.mappy-node-attachments .image-embed')).toHaveLength(1);
    expect(element.querySelector<HTMLElement>('.mappy-node-content')?.hidden).toBe(false);
  });
});

describe('pasting an image onto a node the map is only holding', () => {
  it('leaves the selection on the node that took the image, among same-named ones', async () => {
    const mounted = await mount(SAME_NAMED);
    const { canvas, settle, source } = mounted;
    const [, second] = nodes(mounted, '同じ名前');
    if (!second) throw new Error('The map should show the same-named branches');
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    const selected = second.dataset.nodeId;
    await pasted(mounted, canvas);
    expect(source()).toContain('- 同じ名前\n  二つ目の本文\n\n  ![[1-shot.png]]');
    const [, after] = nodes(mounted, '同じ名前');
    expect(after?.dataset.nodeId).toBe(selected);
    expect(after?.hasClass('is-selected')).toBe(true);
  });

  it('leaves the folds where they were, so a folded same-named branch stays folded', async () => {
    const mounted = await mount(SAME_NAMED);
    const { canvas, key, settle } = mounted;
    const [first, second] = nodes(mounted, '同じ名前');
    if (!first || !second) throw new Error('The map should show the same-named branches');
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(first, ' ');
    await settle();
    const folded = first.dataset.nodeId ?? '';
    expect(folds(mounted).has(folded)).toBe(true);
    expect(nodes(mounted, '一つ目の子')).toHaveLength(0);
    // The image goes to the other branch; the fold on this one is not the map's to drop.
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    await pasted(mounted, canvas);
    expect(folds(mounted).has(folded)).toBe(true);
    expect(nodes(mounted, '一つ目の子')).toHaveLength(0);
    expect(nodes(mounted, '二つ目の子')).toHaveLength(1);
  });
});
