// @vitest-environment jsdom
/**
 * LEV-202: 本人の操作は「ノードのテキストを編集して Shift+Enter で改行し、Enter で確定する」。その操作を対象の形
 * （リストの項目・本文のルート・トピック・Tab で作った空のノード・見出しのノート）ごとに回す。確定前は rename が
 * 「ノード名は改行を含まない文字列にしてください。」で拒否していた（commands.ts の assertSingleLine）。
 *
 * jsdom の textarea は Shift+Enter の既定動作（改行の挿入）を行わないので、ここで見るのは「Shift+Enter で確定しない・
 * 既定動作を止めない」ことと、改行を含む下書きの保存・表示・再編集。改行が実際に入るのはブラウザ検証ページと実機で見る。
 *
 * もう一つは拒否された下書きの行方: エラー行が出た下書きの上でノードをダブルクリックする（もう一度編集しようとする）と、
 * 下書きが捨てられて元の題名で開き直されていた（editTitle の dispose）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', '', '## 買うもの', ''].join('\n');
const HEADINGS = ['# 旅の計画', '', '## 温泉旅行', '', '本文', ''].join('\n');

async function mount(source: string, path = 'Fixtures/line-break.md'): Promise<MountedMapView> {
  const mounted = await mountMapView(path, source);
  opened.push(mounted);
  return mounted;
}

function errorLine(mounted: MountedMapView): string {
  return mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '';
}

function openEditor(mounted: MountedMapView, title: string): HTMLTextAreaElement {
  mounted.key(mounted.select(title), 'F2');
  const input = mounted.editor();
  if (!input) throw new Error(`F2 did not open the inline editor on ${title}`);
  return input;
}

/** Shift+Enter in the draft, then the break it inserts (jsdom does not insert it), then Enter. */
async function typeBreakAndConfirm(mounted: MountedMapView, input: HTMLTextAreaElement, draft: string): Promise<void> {
  const shiftEnter = mounted.key(input, 'Enter', { shiftKey: true });
  expect(shiftEnter.defaultPrevented).toBe(false);
  await mounted.settle();
  expect(mounted.editor()).toBe(input);
  input.value = draft;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(mounted.key(input, 'Enter').defaultPrevented).toBe(true);
  await mounted.settle();
  await mounted.settle();
}

describe('a line break typed inside a node (Shift+Enter, LEV-202)', () => {
  it.each([
    ['a list item', LIST, '温泉旅行', '- 温泉<br>旅行\n  - 予約'],
    ['the body root', LIST, '旅の計画', '## 旅の<br>計画\n'],
    ['a free topic', LIST, '買うもの', '## 買う<br>もの\n'],
    ['a heading of a heading note', HEADINGS, '温泉旅行', '## 温泉<br>旅行\n\n本文'],
  ])('is written as `<br>` in %s, shown as a break and edited as one again', async (_shape, source, title, expected) => {
    const mounted = await mount(source);
    const input = openEditor(mounted, title);
    const draft = title === '温泉旅行' ? '温泉\n旅行' : title === '旅の計画' ? '旅の\n計画' : '買う\nもの';
    await typeBreakAndConfirm(mounted, input, draft);
    expect(errorLine(mounted)).toBe('');
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toContain(expected);
    // On the map: the label breaks at the same place; the node is read out with a space there.
    const name = draft.replace('\n', ' ');
    const node = mounted.node(name);
    expect(node.querySelector('.mappy-node-label br')).not.toBeNull();
    expect(accessibleName(node)).toBe(name);
    // Editing again gives the break back, and confirming it untouched writes nothing.
    const written = mounted.source();
    const again = openEditor(mounted, name);
    expect(again.value).toBe(draft);
    mounted.key(again, 'Enter');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(written);
  });

  it('names an empty node made by Tab with a break', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const input = mounted.editor();
    if (!input) throw new Error('Tab did not open the inline editor');
    await typeBreakAndConfirm(mounted, input, 'タオル\n着替え');
    expect(errorLine(mounted)).toBe('');
    expect(mounted.source()).toContain('- 持ち物\n  - タオル<br>着替え\n');
  });

  it('keeps `<BR/>` as the note wrote it when the draft is confirmed as it opened', async () => {
    const source = LIST.replace('- 温泉旅行', '- 温泉 <BR/> 旅行');
    const mounted = await mount(source);
    const input = openEditor(mounted, '温泉 旅行');
    expect(input.value).toBe('温泉\n旅行');
    mounted.key(input, 'Enter');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(source);
  });

  // Not a regression: this held before LEV-202 too. It pins that the new Shift+Enter branch sits after the IME's.
  it('leaves Shift+Enter to the IME while it is composing', async () => {
    const mounted = await mount(LIST);
    const input = openEditor(mounted, '温泉旅行');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(mounted.key(input, 'Enter', { shiftKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(mounted.key(input, 'Enter', { isComposing: true }).defaultPrevented).toBe(false);
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(mounted.source()).toBe(LIST);
  });
});

describe('a draft the save refused (LEV-202: 拒否される入力でも下書きは消えない)', () => {
  /** A list item named `[ ] …` becomes a task, which is not a node: the rename is refused and the draft kept. */
  async function refused(mounted: MountedMapView): Promise<HTMLTextAreaElement> {
    const input = openEditor(mounted, '温泉旅行');
    input.value = '[ ] 温泉\n旅行';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(errorLine(mounted)).not.toBe('');
    expect(mounted.editor()).toBe(input);
    return input;
  }

  it('stays open with its text when the node is double-clicked to edit it again', async () => {
    const mounted = await mount(LIST);
    const input = await refused(mounted);
    mounted.node('温泉旅行').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(input.value).toBe('[ ] 温泉\n旅行');
    expect(errorLine(mounted)).not.toBe('');
    expect(mounted.source()).toBe(LIST);
  });

  it('stays open with its text when another node is double-clicked', async () => {
    const mounted = await mount(LIST);
    const input = await refused(mounted);
    mounted.node('持ち物').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(input.value).toBe('[ ] 温泉\n旅行');
    expect(mounted.source()).toBe(LIST);
  });

  it('stays open, and no topic is added, when the empty canvas is double-clicked', async () => {
    const mounted = await mount(LIST);
    const input = await refused(mounted);
    mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await mounted.settle();
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(input.value).toBe('[ ] 温泉\n旅行');
    expect(mounted.source()).toBe(LIST);
  });

  it('is confirmed first when it can be saved, and the node double-clicked opens next', async () => {
    const mounted = await mount(LIST);
    const input = openEditor(mounted, '温泉旅行');
    input.value = '温泉\n旅行';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.node('持ち物').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toContain('- 温泉<br>旅行\n');
    expect(mounted.editor()?.value).toBe('持ち物');
  });
});

describe('a topic asked for while the blur is saving the draft (review 3 of LEV-202)', () => {
  it('waits for that save and adds the topic', async () => {
    const mounted = await mount(LIST);
    const input = openEditor(mounted, '温泉旅行');
    input.value = '温泉\n旅行';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // The double click's first press blurs the draft, which starts its save; the double click lands while it runs.
    input.blur();
    mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await mounted.settle();
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toContain('- 温泉<br>旅行\n');
    expect(mounted.source()).toMatch(/\n## トピック\n?$/u);
  });
});

describe('a draft confirmed on the way to another edit while the note leaves (review of LEV-202)', () => {
  // Not a regression test: it passes without the `this.file !== file` check in editTitle too. A navigation waits for
  // the same save (`onUnloadFile` → `flush`) and then drops every draft (`dropDraft`), so the confirm's continuation
  // runs before the leaf changes and whatever it opens is dropped. It pins that outcome; the check guards the order.
  it('opens nothing on the note that took the leaf while the save ran', async () => {
    const mounted = await mount(LIST);
    const other = ['---', 'mappy: true', '---', '## 別のノート', '', '- 一つ目', '- 二つ目', ''].join('\n');
    mounted.app.put('Fixtures/other.md', other);
    const input = openEditor(mounted, '温泉旅行');
    input.value = '温泉\n旅行';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // The double click asks for another edit: the draft is saved first, and the leaf moves on meanwhile.
    mounted.node('持ち物').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const navigation = mounted.view.setState({ file: 'Fixtures/other.md' }, { history: false });
    await navigation;
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toContain('- 温泉<br>旅行\n');
    expect(mounted.view.containerEl.querySelector('.mappy-node')).not.toBeNull();
    expect(mounted.editor()).toBeNull();
  });
});
