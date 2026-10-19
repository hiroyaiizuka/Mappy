// @vitest-environment jsdom
/**
 * LEV-364: 本人の操作は「ノードを選んで右クリックの『色』（またはコマンド）で色を付ける・変える・外す」。その操作を
 * 対象の形（リストの項目・本文のルート・フリートピック・リンク入りの文・同名ノード・空の題名・Markdown で手書きした色）
 * ごとに回し、マップの箱の塗り・ノートの差分（文の範囲だけ）・Undo／Redo の 1 歩・色付きノードの改名を見る。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice } from '../browser-harness/obsidian';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const YELLOW = '<mark style="background: #FFF3A3A6;">';
const BLUE = '<mark style="background: #ADCCFFA6;">';
const LIST = [
  '---', 'mappy: true', 'mappy-topics:', '  トピック: { mindmap: [400, 40] }', '---',
  '## 旅の計画', '', '- 温泉旅行', '  - [[宿]] を予約', '- 同じ', '- 同じ', '- ', '', '## トピック', '',
].join('\n');

const COLORS = ['色なし', '黄色', 'オレンジ', '赤', '緑', '青', '紫'];

async function mount(source = LIST): Promise<MountedMapView> {
  return mountMapView('Fixtures/color.md', source);
}

/** The menu's item titles, and which one is checked. */
function menuState(): { titles: string[]; checked: string[] } {
  const items = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'));
  return {
    titles: items.map(item => item.querySelector('.menu-item-title')?.textContent ?? ''),
    checked: items.filter(item => item.classList.contains('is-checked')).map(item => item.querySelector('.menu-item-title')?.textContent ?? ''),
  };
}

function chooseItem(title: string): void {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
    .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === title);
  if (!item) throw new Error(`No menu item ${title}: ${JSON.stringify(menuState().titles)}`);
  item.click();
}

/** Right-click the node, choose 色, and return the colour menu as it opens (a tick later, once the first menu has gone). */
async function openColorMenu(mounted: MountedMapView, node: HTMLElement): Promise<{ titles: string[]; checked: string[] }> {
  node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  chooseItem('色');
  expect(document.querySelector('.menu')).toBeNull();
  await mounted.settle();
  return menuState();
}

/** Right-click → 色 → the colour, then let the write and the re-read land. */
async function colorFromMenu(mounted: MountedMapView, title: string, color: string, element = mounted.node(title)): Promise<void> {
  await openColorMenu(mounted, element);
  chooseItem(color);
  await mounted.settle();
  await mounted.settle();
}

function fill(element: HTMLElement): string | undefined {
  return element.dataset.mappyColor;
}

function nodes(mounted: MountedMapView, title: string): HTMLElement[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'))
    .filter(element => element.querySelector('.mappy-node-name')?.textContent === title);
}

describe('the colour of a node, chosen on the map (LEV-364)', () => {
  it('opens 色 from the node\'s menu with 色なし and the six, the node\'s colour checked, and colours the item\'s text only', async () => {
    const mounted = await mount();
    const menu = await openColorMenu(mounted, mounted.node('温泉旅行'));
    expect(menu).toEqual({ titles: COLORS, checked: ['色なし'] });
    chooseItem('青');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 温泉旅行', `- ${BLUE}温泉旅行</mark>`));
    const node = mounted.node('温泉旅行');
    expect(fill(node)).toBe('blue');
    expect(node.classList.contains('has-color')).toBe(true);
    // The label shows the text inside the colour; the colour is the box's.
    expect(node.querySelector('.mappy-node-label')?.textContent).toBe('温泉旅行');
    expect(node.classList.contains('is-selected')).toBe(true);
    expect((await openColorMenu(mounted, node)).checked).toEqual(['青']);
  });

  it('changes and takes off the colour, each one step back with ⌘Z and forward with ⌘⇧Z', async () => {
    const mounted = await mount();
    await colorFromMenu(mounted, '温泉旅行', '黄色');
    await colorFromMenu(mounted, '温泉旅行', '赤');
    const red = LIST.replace('- 温泉旅行', '- <mark style="background: #FF5582A6;">温泉旅行</mark>');
    expect(mounted.source()).toBe(red);
    await colorFromMenu(mounted, '温泉旅行', '色なし');
    expect(mounted.source()).toBe(LIST);
    expect(fill(mounted.node('温泉旅行'))).toBeUndefined();
    mounted.key(mounted.canvas, 'z', { metaKey: true });
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(red);
    expect(fill(mounted.node('温泉旅行'))).toBe('red');
    mounted.key(mounted.canvas, 'z', { metaKey: true });
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 温泉旅行', `- ${YELLOW}温泉旅行</mark>`));
    mounted.key(mounted.canvas, 'z', { metaKey: true, shiftKey: true });
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(red);
  });

  it('writes nothing for the colour the node already has', async () => {
    const mounted = await mount(LIST.replace('- 温泉旅行', '- ==温泉旅行=='));
    const node = mounted.node('温泉旅行');
    // Obsidian's highlight over the whole text reads as yellow.
    expect(fill(node)).toBe('yellow');
    expect((await openColorMenu(mounted, node)).checked).toEqual(['黄色']);
    chooseItem('黄色');
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 温泉旅行', '- ==温泉旅行=='));
    expect(Notice.log).toEqual([]);
  });

  it('colours one of two same-named items, the root, an empty node and a free topic, whose position stays with it', async () => {
    const mounted = await mount();
    const [, second] = nodes(mounted, '同じ');
    if (!second) throw new Error('No second 同じ');
    await colorFromMenu(mounted, '同じ', '緑', second);
    const [first, colored] = nodes(mounted, '同じ');
    expect([fill(first as HTMLElement), fill(colored as HTMLElement)]).toEqual([undefined, 'green']);
    await colorFromMenu(mounted, '旅の計画', '紫');
    await colorFromMenu(mounted, '空のノード', 'オレンジ');
    await colorFromMenu(mounted, 'トピック', '黄色');
    expect(mounted.source()).toBe([
      '---', 'mappy: true', 'mappy-topics:', '  トピック: { mindmap: [400, 40] }', '---',
      '## <mark style="background: #D2B3FFA6;">旅の計画</mark>', '', '- 温泉旅行', '  - [[宿]] を予約', '- 同じ',
      '- <mark style="background: #BBFABBA6;">同じ</mark>', '- <mark style="background: #FFB86CA6;"></mark>', '',
      `## ${YELLOW}トピック</mark>`, '',
    ].join('\n'));
    expect(fill(mounted.node('旅の計画'))).toBe('purple');
    expect(fill(mounted.node('空のノード'))).toBe('orange');
    // The empty node keeps the empty node's box.
    expect(mounted.node('空のノード').classList.contains('is-empty')).toBe(true);
    expect(fill(mounted.node('トピック'))).toBe('yellow');
  });

  it('colours a node with a link in its text, the link still a link', async () => {
    const mounted = await mount();
    await colorFromMenu(mounted, '[[宿]] を予約', '青');
    expect(mounted.source()).toContain(`  - ${BLUE}[[宿]] を予約</mark>`);
    const node = mounted.node('[[宿]] を予約');
    expect(fill(node)).toBe('blue');
    expect(node.querySelector('.mappy-node-label a')?.textContent).toBe('宿');
  });

  it('keeps the colour when the node is renamed in place: the editor holds the text inside it', async () => {
    const mounted = await mount(LIST.replace('- 温泉旅行', `- ${BLUE}温泉旅行</mark>`));
    mounted.key(mounted.select('温泉旅行'), 'F2');
    const input = mounted.editor();
    if (!input) throw new Error('F2 did not open the editor');
    expect(input.value).toBe('温泉旅行');
    input.value = '温泉旅行（箱根）';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Enter');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 温泉旅行', `- ${BLUE}温泉旅行（箱根）</mark>`));
    expect(fill(mounted.node('温泉旅行（箱根）'))).toBe('blue');
  });

  it('refuses a rename that would break the colour, the draft kept with the reason', async () => {
    const mounted = await mount(LIST.replace('- 温泉旅行', `- ${BLUE}温泉旅行</mark>`));
    mounted.key(mounted.select('温泉旅行'), 'F2');
    const input = mounted.editor();
    if (!input) throw new Error('F2 did not open the editor');
    input.value = '温泉</mark>旅行';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 温泉旅行', `- ${BLUE}温泉旅行</mark>`));
    expect(mounted.editor()).toBe(input);
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent).toContain('色の印');
  });

  it('shows a colour written in Markdown by hand, and follows it when it changes outside the map', async () => {
    const mounted = await mount(LIST.replace('- 温泉旅行', '- <mark style="background: #123456;">温泉旅行</mark>'));
    const node = mounted.node('温泉旅行');
    expect(fill(node)).toBe('custom');
    expect(node.style.getPropertyValue('--mappy-node-custom')).toBe('#123456');
    // Rewritten behind the map's back (put reports `modify`); the refresh waits out its debounce.
    mounted.app.put('Fixtures/color.md', LIST.replace('- 温泉旅行', `- ${YELLOW}温泉旅行</mark>`));
    await new Promise(resolve => setTimeout(resolve, 100));
    await mounted.settle();
    const updated = mounted.node('温泉旅行');
    expect(fill(updated)).toBe('yellow');
    expect(updated.style.getPropertyValue('--mappy-node-custom')).toBe('');
  });

  it('colours the selected node from the commands, and only when the map has one of its own selected', async () => {
    const mounted = await mount();
    mounted.select('温泉旅行');
    expect(mounted.view.canColor()).toBe(true);
    mounted.view.setColor('green');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 温泉旅行', '- <mark style="background: #BBFABBA6;">温泉旅行</mark>'));
    mounted.view.setColor(null);
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
    // A click on the empty canvas selects nothing: no command applies.
    mounted.canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    mounted.canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    mounted.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    await mounted.settle();
    expect(mounted.view.canColor()).toBe(false);
  });
});
