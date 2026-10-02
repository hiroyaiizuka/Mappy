// @vitest-environment jsdom
/**
 * LEV-301（本人の報告 2026-10-02）: 本文が空のノートをマップにすると中心にファイル名（「無題のファイル 49」）の仮の根が
 * 出る。ダブルクリック／F2 では「このノードはファイル名です。」と出て名前を変えられず、Tab では最上位の見出し
 * 「トピック」が書かれて、それが根に代わってファイル名が消えた（項目のあるノートでは離れたフリートピックになった）。
 *
 * 行列は本人の操作（ダブルクリック・F2・Tab・Enter・画像の貼り付け）× 対象の形（本文が空・frontmatter だけ・見出しの
 * 無い段落・見出しの無い項目・項目の後に H2 のトピック・既存の H1）。期待は「書かれた原文」と「地図の根」の両方で見る。
 * 必須ケースから: ⌘Z 1 回で書く前に戻る・日本語変換中の Enter は確定しない・下書き中の外部変更・同じノートの 2 枚目のビュー。
 *
 * 修正を戻すと落ちるのはダブルクリック・F2・Tab の行と、日本語変換・外部変更・複数ビューの行（artifacts/lev-301/
 * reverted-run.txt）。Enter・貼り付け・H1・「Tab の後の Escape」の行は戻しても通る: 根の扱いを変えたことで、変えて
 * いない操作（兄弟の拒否・本文への画像・見出しの名前の変更・追加の取り消し）を巻き込んでいないことの対照。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice } from '../browser-harness/obsidian';
import { HarnessApp } from '../browser-harness/app';
import { projectMap, type MindDocument } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import { t } from '../../src/i18n';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenViews();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const PATH = 'Fixtures/無題のファイル 49.md';
const FILE = '無題のファイル 49';
const FM = '---\nmappy: true\n---\n';

interface Shape { id: string; source: string; renamed: string; tab: string }

const SHAPES: readonly Shape[] = [
  { id: '本文が空', source: '', renamed: '## 新しい名前', tab: `## ${FILE}\n\n- メイントピック` },
  { id: 'frontmatter だけ', source: FM, renamed: `${FM}\n## 新しい名前\n`, tab: `${FM}\n## ${FILE}\n\n- メイントピック\n` },
  { id: '見出しの無い段落', source: `${FM}メモ\n`, renamed: `${FM}\n## 新しい名前\n\nメモ\n`, tab: `${FM}\n## ${FILE}\n\nメモ\n\n- メイントピック\n` },
  {
    id: '見出しの無い項目', source: `${FM}- 温泉旅行\n  - 予約\n`,
    renamed: `${FM}\n## 新しい名前\n\n- 温泉旅行\n  - 予約\n`, tab: `${FM}\n## ${FILE}\n\n- 温泉旅行\n  - 予約\n- メイントピック\n`,
  },
  {
    id: '項目の後に H2 のトピック', source: `${FM}- a\n\n## 別の話\n- b\n`,
    renamed: `${FM}\n## 新しい名前\n\n- a\n\n## 別の話\n- b\n`, tab: `${FM}\n## ${FILE}\n\n- a\n- メイントピック\n\n## 別の話\n- b\n`,
  },
];

function documentOf(mounted: MountedMapView): MindDocument {
  const document = mounted.view.snapshot()?.document;
  if (!document) throw new Error('The view has no document');
  return document;
}

function bodyRoot(mounted: MountedMapView): { kind: string; title: string; children: string[] } {
  const root = projectMap(documentOf(mounted)).root;
  return { kind: root.kind, title: root.title, children: root.children.map(child => child.title) };
}

function selectedTitle(mounted: MountedMapView): string | undefined {
  const selected = mounted.view.containerEl.querySelector<HTMLElement>('.mappy-node.is-selected')?.dataset.nodeId;
  const document = documentOf(mounted);
  return selected === 'root' ? document.root.title : document.nodes.find(node => node.id === selected)?.title;
}

function dblclick(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
}

async function undo(mounted: MountedMapView): Promise<void> {
  mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
  await mounted.settle();
}

/** Type `text` into the open draft, as the input event the textarea fires. */
function type(mounted: MountedMapView, text: string): HTMLTextAreaElement {
  const input = mounted.editor();
  if (!input) throw new Error('No inline editor is open');
  input.value = text;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  return input;
}

const OPEN = {
  'ダブルクリック': (mounted: MountedMapView) => { dblclick(mounted.node(FILE)); },
  F2: (mounted: MountedMapView) => { mounted.key(mounted.select(FILE), 'F2'); },
} as const;

describe('the file-name root of a note without a heading section (LEV-301)', () => {
  for (const shape of SHAPES) {
    describe(shape.id, () => {
      for (const [operation, open] of Object.entries(OPEN)) {
        it(`${operation}: opens the file name for editing, writes the new name as the root, and ⌘Z once takes it back`, async () => {
          const mounted = await mountMapView(PATH, shape.source);
          open(mounted);
          await mounted.settle();
          expect(Notice.log).toEqual([]);
          expect(mounted.editor()?.value).toBe(FILE);
          mounted.key(type(mounted, '新しい名前'), 'Enter');
          await mounted.settle();
          expect(mounted.editor()).toBeNull();
          expect(mounted.source()).toBe(shape.renamed);
          expect(bodyRoot(mounted)).toMatchObject({ kind: 'atx', title: '新しい名前' });
          expect(selectedTitle(mounted)).toBe('新しい名前');
          await undo(mounted);
          expect(mounted.source()).toBe(shape.source);
          expect(bodyRoot(mounted)).toMatchObject({ kind: 'root', title: FILE });
          expect(Notice.log).toEqual([]);
        });
      }

      it('ダブルクリック: Enter or a click elsewhere with the file name left as it is writes nothing', async () => {
        const mounted = await mountMapView(PATH, shape.source);
        dblclick(mounted.node(FILE));
        await mounted.settle();
        mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
        await mounted.settle();
        expect(mounted.editor()).toBeNull();
        expect(mounted.source()).toBe(shape.source);
        expect(selectedTitle(mounted)).toBe(FILE);
        dblclick(mounted.node(FILE));
        await mounted.settle();
        mounted.editor()?.blur();
        await mounted.settle();
        expect(mounted.editor()).toBeNull();
        expect(mounted.source()).toBe(shape.source);
        expect(Notice.log).toEqual([]);
      });

      it('Tab: keeps the file name in the middle and joins「メイントピック」to its right; ⌘Z once takes both back', async () => {
        const mounted = await mountMapView(PATH, shape.source);
        mounted.key(mounted.select(FILE), 'Tab');
        await mounted.settle();
        expect(mounted.editor()?.value).toBe(t().mainTopicTitle);
        mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
        await mounted.settle();
        expect(mounted.source()).toBe(shape.tab);
        expect(bodyRoot(mounted)).toMatchObject({ kind: 'atx', title: FILE });
        expect(bodyRoot(mounted).children.at(-1)).toBe(t().mainTopicTitle);
        expect(selectedTitle(mounted)).toBe(t().mainTopicTitle);
        await undo(mounted);
        expect(mounted.source()).toBe(shape.source);
        expect(Notice.log).toEqual([]);
      });

      // A control too: before the fix Escape took back the 「トピック」 heading the same way.
      it('Tab, then Escape on the untouched「メイントピック」: the note is as it was', async () => {
        const mounted = await mountMapView(PATH, shape.source);
        mounted.key(mounted.select(FILE), 'Tab');
        await mounted.settle();
        mounted.key(mounted.editor() ?? mounted.canvas, 'Escape');
        await mounted.settle();
        expect(mounted.source()).toBe(shape.source);
        expect(bodyRoot(mounted)).toMatchObject({ kind: 'root', title: FILE });
      });

      it('F2, a new name, then Tab: the name is written as the root and「メイントピック」hangs under it', async () => {
        const mounted = await mountMapView(PATH, shape.source);
        mounted.key(mounted.select(FILE), 'F2');
        await mounted.settle();
        mounted.key(type(mounted, '新しい名前'), 'Tab');
        await mounted.settle();
        expect(mounted.editor()?.value).toBe(t().mainTopicTitle);
        mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
        await mounted.settle();
        expect(bodyRoot(mounted)).toMatchObject({ kind: 'atx', title: '新しい名前' });
        expect(bodyRoot(mounted).children.at(-1)).toBe(t().mainTopicTitle);
      });

      // Controls: they pass with the fix reverted too.
      it('Enter: a sibling of the file name is still refused, and nothing is written', async () => {
        const mounted = await mountMapView(PATH, shape.source);
        mounted.key(mounted.select(FILE), 'Enter');
        await mounted.settle();
        expect(mounted.source()).toBe(shape.source);
        expect(mounted.editor()).toBeNull();
      });

      it('画像の貼り付け: the image goes into the file name\'s text, and no heading is written for it', async () => {
        const mounted = await mountMapView(PATH, shape.source);
        mounted.select(FILE);
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: { files: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })] } });
        mounted.canvas.dispatchEvent(paste);
        await mounted.settle();
        await mounted.settle();
        expect(mounted.source()).toContain('shot.png');
        expect(mounted.source()).not.toContain(`## ${FILE}`);
        expect(bodyRoot(mounted)).toMatchObject({ kind: 'root', title: FILE });
      });
    });
  }

  it('既存の H1: the H1 is the root and is renamed as any heading is; no file-name root is shown (control)', async () => {
    const mounted = await mountMapView(PATH, `${FM}# 見出し\n\n- 項目\n`);
    expect(() => mounted.node(FILE)).toThrow();
    dblclick(mounted.node('見出し'));
    await mounted.settle();
    mounted.key(type(mounted, '新しい見出し'), 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(`${FM}# 新しい見出し\n\n- 項目\n`);
  });

  it('日本語変換中の Enter does not confirm the draft; the Enter after the composition writes the name', async () => {
    const mounted = await mountMapView(PATH, FM);
    dblclick(mounted.node(FILE));
    await mounted.settle();
    const input = type(mounted, 'しんしい');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    mounted.key(input, 'Enter', { isComposing: true });
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(mounted.source()).toBe(FM);
    type(mounted, '新しい');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(`${FM}\n## 新しい\n`);
  });

  it('外部変更: an item added from outside while the draft is open is kept under the name the draft writes', async () => {
    const app = new HarnessApp();
    const mounted = await mountMapView(PATH, `${FM}- a\n`, 'mindmap', app);
    dblclick(mounted.node(FILE));
    await mounted.settle();
    type(mounted, '新しい名前');
    app.put(PATH, `${FM}- a\n- 外から\n`);
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
    mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(`${FM}\n## 新しい名前\n\n- a\n- 外から\n`);
  });

  // Code review of LEV-301: the refusal named the root's own rule (「ルートでは子ノードの追加だけ」) instead of what happened.
  it('外部変更: a heading written from outside while the draft is open is not written over, and the draft says its node is gone', async () => {
    const app = new HarnessApp();
    const mounted = await mountMapView(PATH, `${FM}- a\n`, 'mindmap', app);
    dblclick(mounted.node(FILE));
    await mounted.settle();
    type(mounted, '新しい名前');
    const outside = `${FM}## 外の見出し\n- a\n`;
    app.put(PATH, outside);
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
    mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(outside);
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent).toBe(t().nodeGone);
  });

  // Code review of LEV-301 (2nd): the window losing the OS focus saves the draft in place (LEV-216) and keeps it open. The
  // save turns the file name into a heading, so the draft must follow that heading: the Enter, or more typing, on coming back.
  describe('ウィンドウのフォーカスが外れる (LEV-216)', () => {
    async function leave(): Promise<{ mounted: MountedMapView; input: HTMLTextAreaElement; windowFocus: { mockReturnValue(value: boolean): unknown } }> {
      const mounted = await mountMapView(PATH, `${FM}- a\n`);
      mounted.key(mounted.select(FILE), 'F2');
      await mounted.settle();
      const input = type(mounted, '新しい名前');
      const windowFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      input.dispatchEvent(new FocusEvent('blur'));
      await mounted.settle();
      return { mounted, input, windowFocus };
    }

    it('saves the name as the root and keeps the draft; the Enter on coming back closes it without a refusal', async () => {
      const { mounted, input, windowFocus } = await leave();
      expect(mounted.source()).toBe(`${FM}\n## 新しい名前\n\n- a\n`);
      expect(mounted.editor()).toBe(input);
      windowFocus.mockReturnValue(true);
      mounted.key(input, 'Enter');
      await mounted.settle();
      expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '').toBe('');
      expect(mounted.editor()).toBeNull();
      expect(mounted.source()).toBe(`${FM}\n## 新しい名前\n\n- a\n`);
      expect(selectedTitle(mounted)).toBe('新しい名前');
    });

    it('takes what is typed after coming back, and Tab then adds「メイントピック」under the root', async () => {
      const { mounted, input, windowFocus } = await leave();
      windowFocus.mockReturnValue(true);
      type(mounted, '書き足した名前');
      mounted.key(input, 'Tab');
      await mounted.settle();
      expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '').toBe('');
      expect(mounted.editor()?.value).toBe(t().mainTopicTitle);
      mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
      await mounted.settle();
      expect(mounted.source()).toBe(`${FM}\n## 書き足した名前\n\n- a\n- ${t().mainTopicTitle}\n`);
    });

    // A control: it passes with this round's view fix reverted too, since the redraw selects the body root once the draft's node is gone.
    it('keeps the named root selected when the draft is then dismissed with Escape', async () => {
      const { mounted, input, windowFocus } = await leave();
      windowFocus.mockReturnValue(true);
      mounted.key(input, 'Escape');
      await mounted.settle();
      expect(mounted.editor()).toBeNull();
      expect(mounted.source()).toBe(`${FM}\n## 新しい名前\n\n- a\n`);
      expect(selectedTitle(mounted)).toBe('新しい名前');
    });
  });

  // Code review of LEV-301 (2nd): a command for the root while its draft is open (the menu's 子を追加, a called map) runs
  // after the draft's save, on the heading that save wrote — not on the parse root behind it, which made a free topic.
  it('下書き中の「子を追加」: the draft is written first and the item hangs under the named root', async () => {
    const mounted = await mountMapView(PATH, `${FM}- a\n`);
    mounted.key(mounted.select(FILE), 'F2');
    await mounted.settle();
    type(mounted, '新しい名前');
    await (mounted.view as unknown as { execute(command: unknown): Promise<void> }).execute({ type: 'add-child', nodeId: 'root' });
    await mounted.settle();
    expect(mounted.editor()?.value).toBe(t().mainTopicTitle);
    mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(`${FM}\n## 新しい名前\n\n- a\n- ${t().mainTopicTitle}\n`);
  });

  it('複数ビュー: the other view of the note shows the file name as the written root, with the new item under it', async () => {
    const app = new HarnessApp();
    app.put(PATH, FM);
    const store = new DocumentStore(app.asApp<App>());
    const first = await mountMapView(PATH, FM, 'mindmap', app, { store });
    const second = await mountMapView(PATH, FM, 'timeline', app, { store });
    first.key(first.select(FILE), 'Tab');
    await first.settle();
    first.key(first.editor() ?? first.canvas, 'Enter');
    await first.settle();
    await new Promise(resolve => setTimeout(resolve, 60));
    await second.settle();
    expect(bodyRoot(second)).toEqual({ kind: 'atx', title: FILE, children: [t().mainTopicTitle] });
  });
});
