// @vitest-environment jsdom
/**
 * LEV-141: 開いている下書きと、マップ自身の書き込み（コマンド・⌘Z／⌘⇧Z・貼り付け）の残り 4 件。E05 の照合の相手は外部の変更だけで、
 * マップ自身の書き込みは含まない（product-plan §5 M2）。行列は本人の操作 × 対象の形。
 *
 * 1. 下書きの確定で id が変わり、コマンドが的外れの「対象のノードが変更されています」で落ちる（`execute`）。
 *    操作（子・兄弟・削除・上へ・下へ）× 形（一意・題名が空の項目・同名の 2 つ目・題名が空の見出し・空白に置いたトピック
 *    を命名中）。LEV-146 で自身の書き込みが id を引き継ぐようになってから再現しない。この行列は、その引き継ぎが
 *    `execute` の経路でも効いていることを固定する（引き継ぎを外すと落ちる: artifacts/lev-141-draft-own-write-rest/record.md）。
 * 2. 拒否されるコマンドが、先に下書きを書いてしまう（`execute`）。操作（メニューの子・兄弟・上へ・下へ、マップの呼び出し）×
 *    拒否の形（H6 の子・兄弟、見出しの無いリストのノートでトピックを上へ）。
 * 3. ⌘Z／⌘⇧Z（メニューの「元に戻す」「やり直す」）が下書きを再ベースしない（`history`）。操作（Undo・Redo）× 手順の形
 *    （下書きのノードに貼った画像・下書きのノードの改名・別のノードへの追加・下書きのノードそのものの追加）。
 * 4. 実クリップボード: 貼り付けは入力欄（textarea）で起き、キャンバスまで上がってくる。形（画像だけ・文字だけ・画像と文字）。
 *    実機の OS クリップボードは scripts/e2e/draft-own-write.mjs（E77）。
 */
import type { App, TFile } from 'obsidian';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessApp } from '../browser-harness/app';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice } from '../browser-harness/obsidian';
import type { MindDocument, MindNode } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import { t } from '../../src/i18n';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';
import { InlineEditor } from '../../src/ui/inline-editor';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });
beforeEach(() => { Notice.log.length = 0; });
afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/draft-own-write.md';
type Command = 'add-child' | 'add-sibling' | 'delete' | 'move-up' | 'move-down';
interface Internals {
  executeSelected(type: Command): void;
  callMap(target: TFile): Promise<void>;
}

interface Mounted extends MountedMapView {
  store: DocumentStore;
  internals: Internals;
  document: () => MindDocument;
  /** Click the node, double click it, and type `text` into the draft that opens, without confirming it. */
  draft: (node: MindNode, text: string) => Promise<HTMLTextAreaElement>;
  error: () => string;
  /** Choose an item of the context menu opened on the canvas's empty space. */
  menu: (title: string) => Promise<void>;
  /** Let the saves, the re-reads and the refresh debounce run out. */
  idle: () => Promise<void>;
}

async function mount(source: string, others: Record<string, string> = {}): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, source);
  for (const [path, text] of Object.entries(others)) app.put(path, text);
  const store = new DocumentStore(app.asApp<App>());
  const mounted = await mountMapView(PATH, source, 'mindmap', app, { store });
  const document = (): MindDocument => {
    const parsed = mounted.view.snapshot()?.document;
    if (!parsed) throw new Error('The view has no document');
    return parsed;
  };
  const idle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) await mounted.settle();
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
  };
  return {
    ...mounted, store, document, idle,
    internals: mounted.view as unknown as Internals,
    error: () => mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '',
    draft: async (node, text) => {
      const element = mounted.view.containerEl.querySelector<HTMLElement>(`.mappy-node[data-node-id="${node.id}"]`);
      if (!element) throw new Error(`No element for ${node.id}`);
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await mounted.settle();
      const input = mounted.editor();
      if (!input) throw new Error(`The inline editor did not open on ${node.id}`);
      input.value = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return input;
    },
    menu: async title => {
      mounted.canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 700 }));
      const item = Array.from(globalThis.document.querySelectorAll<HTMLElement>('.menu .menu-item'))
        .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === title);
      if (!item) throw new Error(`Menu item ${title} is not open`);
      item.click();
      await idle();
    },
  };
}

function find(document: MindDocument, title: string, nth = 0): MindNode {
  const node = document.nodes.filter(candidate => candidate.title === title)[nth];
  if (!node) throw new Error(`No node ${title} #${nth}`);
  return node;
}

describe('1. a command run over an open draft finds its node after the draft is written (LEV-141)', () => {
  const LIST = ['---', 'mappy: true', '---', '## 計画', '', '- 一意', '  - 子', '- ', '  ![[a.png]]', '- 同名', '- 同名', '- 末尾', ''].join('\n');
  const EMPTY_HEADING = ['# 計画', '', '## ', '', '![[a.png]]', '', '## 二つ目', ''].join('\n');
  const TOPIC = ['---', 'mappy: true', '---', '## 計画', '', '- 一意', ''].join('\n');
  const SHAPES: readonly { id: string; source: string; open: (mounted: Mounted) => Promise<HTMLTextAreaElement> }[] = [
    { id: '一意の項目', source: LIST, open: mounted => mounted.draft(find(mounted.document(), '一意'), '命名') },
    { id: '題名が空の項目（画像だけ）', source: LIST, open: mounted => mounted.draft(find(mounted.document(), ''), '命名') },
    { id: '同名の 2 つ目', source: LIST, open: mounted => mounted.draft(find(mounted.document(), '同名', 1), '命名') },
    { id: '題名が空の見出し', source: EMPTY_HEADING, open: mounted => mounted.draft(find(mounted.document(), ''), '命名') },
    {
      id: '空白に置いたトピックを命名中', source: TOPIC,
      open: async mounted => {
        mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 400 }));
        await mounted.idle();
        const input = mounted.editor();
        if (!input) throw new Error('No draft on the new topic');
        input.value = '命名';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return input;
      },
    },
  ];
  const COMMANDS: readonly Command[] = ['add-child', 'add-sibling', 'delete', 'move-up', 'move-down'];
  for (const shape of SHAPES) {
    for (const command of COMMANDS) {
      it(`${shape.id} × ${command}`, async () => {
        const mounted = await mount(shape.source);
        await shape.open(mounted);
        const before = mounted.source();
        mounted.internals.executeSelected(command);
        await mounted.idle();
        expect(Notice.log).toEqual([]);
        expect(mounted.error()).toBe('');
        // The draft was written and the command ran on the node it was typed on (a delete takes the named node away).
        if (command === 'delete') expect(mounted.source()).not.toContain('命名');
        else expect(mounted.source()).toMatch(/[-#] 命名\n/u);
        if (command === 'add-child' || command === 'add-sibling') {
          expect(mounted.editor()?.value).toMatch(new RegExp(`^(${t().newNodeTitle}|${t().mainTopicTitle}|${t().newTopicTitle})$`, 'u'));
        }
        expect(mounted.source()).not.toBe(before);
      });
    }
  }
});

describe('2. a command the note refuses leaves the open draft unwritten, with the refusal (LEV-141)', () => {
  const H6 = ['# 計画', '', '## 二', '', '### 三', '', '#### 四', '', '##### 五', '', '###### 六', ''].join('\n');
  const HEADLESS = '- 項目\n';
  const OTHER = 'Fixtures/other.md';
  const ROWS: readonly {
    id: string; source: string; refusal: string;
    open: (mounted: Mounted) => Promise<HTMLTextAreaElement>;
    run: (mounted: Mounted) => Promise<void>;
  }[] = [
    {
      id: 'H6 × メニューの「子を追加」', source: H6, refusal: t().headingDepth,
      open: mounted => mounted.draft(find(mounted.document(), '六'), '六（編集）'),
      run: async mounted => { mounted.internals.executeSelected('add-child'); await mounted.idle(); },
    },
    {
      id: 'H6 × マップを呼び出す', source: H6, refusal: t().headingDepth,
      open: mounted => mounted.draft(find(mounted.document(), '六'), '六（編集）'),
      run: async mounted => {
        const target = mounted.app.asApp<App>().vault.getAbstractFileByPath(OTHER) as TFile;
        await mounted.internals.callMap(target).catch((error: unknown) => { new Notice((error as Error).message); });
        await mounted.idle();
      },
    },
    {
      id: '見出しの無いリストのノートのトピック × 上へ', source: HEADLESS, refusal: t().listUnsafe,
      open: async mounted => {
        mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 400 }));
        await mounted.idle();
        // The topic is written under its provisional name first (LEV-203): that write is the baseline here.
        const input = mounted.editor();
        if (!input) throw new Error('No draft on the new topic');
        input.value = '命名';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return input;
      },
      run: async mounted => { mounted.internals.executeSelected('move-up'); await mounted.idle(); },
    },
  ];
  for (const row of ROWS) {
    it(row.id, async () => {
      const mounted = await mount(row.source, { [OTHER]: '# 別のマップ\n' });
      const input = await row.open(mounted);
      const typed = input.value;
      const before = mounted.source();
      await row.run(mounted);
      // Refused as before the command confirmed drafts (LEV-140): nothing written, the draft still open with the user's text.
      expect(Notice.log).toEqual([row.refusal]);
      expect(mounted.source()).toBe(before);
      expect(mounted.editor()).toBe(input);
      expect(input.value).toBe(typed);
      // Enter still writes the draft.
      mounted.key(input, 'Enter');
      await mounted.idle();
      expect(mounted.editor()).toBeNull();
      expect(mounted.source()).toContain(typed);
    });
  }

  it('a command that finds another write of the map\'s own under way once the draft is written says so, rather than stopping silently', async () => {
    const LIST = ['---', 'mappy: true', '---', '## 計画', '', '- 学ぶこと', '- 記録する', ''].join('\n');
    const mounted = await mount(LIST);
    await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    // Right after the draft's save, another write of this view begins (a layout button's, a pasted image's).
    const view = mounted.view as unknown as { saving: boolean };
    const confirm = (editor: InlineEditor): Promise<boolean> => InlineEditor.prototype.confirm.call(editor);
    const spy = vi.spyOn(InlineEditor.prototype, 'confirm').mockImplementationOnce(async function (this: InlineEditor) {
      spy.mockRestore();
      const closed = await confirm(this);
      view.saving = true;
      return closed;
    });
    mounted.internals.executeSelected('add-child');
    await mounted.idle();
    spy.mockRestore();
    view.saving = false;
    expect(Notice.log).toEqual([t().draftSavedCommandRefused(t().savingWait)]);
    expect(mounted.source()).toBe(LIST.replace('- 学ぶこと\n', '- 学ぶこと（編集）\n'));
  });

  it('a command refused only after the draft was written (the note changed during that save) says the draft was saved', async () => {
    const LIST = ['---', 'mappy: true', '---', '## 計画', '', '- 学ぶこと', '- 記録する', ''].join('\n');
    const mounted = await mount(LIST);
    const input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    // Right after the draft's save lands, another app deletes the node the command is for.
    const applyOver = mounted.store.applyOver.bind(mounted.store);
    const spy = vi.spyOn(mounted.store, 'applyOver').mockImplementationOnce(async (...args) => {
      const write = await applyOver(...args);
      mounted.app.put(PATH, write.after.replace('- 学ぶこと（編集）\n', ''));
      return write;
    });
    mounted.internals.executeSelected('add-child');
    await mounted.idle();
    spy.mockRestore();
    expect(mounted.editor()).not.toBe(input);
    expect(Notice.log).toEqual([t().draftSavedCommandRefused(t().nodeChanged)]);
    expect(mounted.source()).toBe(LIST.replace('- 学ぶこと\n', ''));
  });
});

describe('3. ⌘Z／⌘⇧Z over an open draft are the map\'s own writes, not a change to refuse it for (LEV-141)', () => {
  const LIST = ['---', 'mappy: true', '---', '## 計画', '', '- 学ぶこと', '- 記録する', ''].join('\n');
  const image = (): File => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  const paste = (target: EventTarget, files: File[], text = ''): Event => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: (type: string) => (type === 'text/plain' ? text : '') } });
    target.dispatchEvent(event);
    return event;
  };

  it('Undo of an image pasted onto the node being edited: Enter writes the draft', async () => {
    const mounted = await mount(LIST);
    const input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    paste(mounted.canvas, [image()]);
    await mounted.idle();
    expect(mounted.source()).toContain('![[1-shot.png]]');
    await mounted.menu(t().undo);
    expect(mounted.source()).toBe(LIST);
    expect(mounted.editor()).toBe(input);
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe('');
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(LIST.replace('- 学ぶこと\n', '- 学ぶこと（編集）\n'));
  });

  it('Redo of an image pasted onto the node before its draft opened: Enter writes the draft beside it', async () => {
    const mounted = await mount(LIST);
    mounted.select('学ぶこと');
    paste(mounted.canvas, [image()]);
    await mounted.idle();
    await mounted.menu(t().undo);
    expect(mounted.source()).toBe(LIST);
    const input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    await mounted.menu(t().redo);
    expect(mounted.source()).toContain('![[1-shot.png]]');
    expect(mounted.editor()).toBe(input);
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe('');
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toContain('- 学ぶこと（編集）\n\n  ![[1-shot.png]]');
  });

  it('Undo of the rename of the node being edited: Enter writes the draft over the title Undo brought back', async () => {
    const mounted = await mount(LIST);
    let input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶ');
    mounted.key(input, 'Enter');
    await mounted.idle();
    input = await mounted.draft(find(mounted.document(), '学ぶ'), '学ぶこと（編集）');
    await mounted.menu(t().undo);
    expect(mounted.source()).toBe(LIST);
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe('');
    expect(mounted.source()).toBe(LIST.replace('- 学ぶこと\n', '- 学ぶこと（編集）\n'));
  });

  it('Undo of the rename of the node being edited, nothing typed: the draft takes the title Undo brought back, and Enter keeps it', async () => {
    const mounted = await mount(LIST);
    let input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶ');
    mounted.key(input, 'Enter');
    await mounted.idle();
    // Opened again and left as it opened.
    input = await mounted.draft(find(mounted.document(), '学ぶ'), '学ぶ');
    await mounted.menu(t().undo);
    expect(mounted.source()).toBe(LIST);
    expect(mounted.editor()).toBe(input);
    expect(input.value).toBe('学ぶこと');
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe('');
    // The Undo stands: the draft did not write the undone title back.
    expect(mounted.source()).toBe(LIST);
  });

  // Pins, not regressions (they pass with the fix reverted): Undo of a step that never touched the drafted node leaves
  // its fingerprint as it was, so the draft was never refused there; this row keeps it so.
  it('Undo of an addition elsewhere: Enter writes the draft (the draft\'s node never changed)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('記録する'), 'Tab');
    await mounted.idle();
    mounted.key(mounted.editor() as HTMLTextAreaElement, 'Enter');
    await mounted.idle();
    const input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    await mounted.menu(t().undo);
    expect(mounted.source()).toBe(LIST);
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe('');
    expect(mounted.source()).toBe(LIST.replace('- 学ぶこと\n', '- 学ぶこと（編集）\n'));
  });

  it('Undo of the addition of the node being edited: the draft is refused as its node is gone, and nothing is written', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('記録する'), 'Tab');
    await mounted.idle();
    // Written under its provisional name; the name typed over it is a draft Enter would save.
    mounted.key(mounted.editor() as HTMLTextAreaElement, 'Enter');
    await mounted.idle();
    const input = await mounted.draft(find(mounted.document(), t().newNodeTitle), '新しい項目');
    await mounted.menu(t().undo);
    await mounted.menu(t().undo);
    expect(mounted.source()).toBe(LIST);
    // What this row pins (it passes with the fix reverted too): the draft outlives its node's removal by Undo, and its
    // save is refused as the node is gone, not written somewhere else.
    expect(mounted.editor()).toBe(input);
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe(t().nodeGone);
    expect(mounted.source()).toBe(LIST);
  });

  it('Undo chosen while an image pasted onto the node being edited is still being written: Enter writes the draft', async () => {
    const mounted = await mount(LIST);
    // An earlier step, so the menu's Undo is enabled while the paste is still on its way.
    let first = await mounted.draft(find(mounted.document(), '記録する'), '記録');
    mounted.key(first, 'Enter');
    await mounted.idle();
    first = await mounted.draft(find(mounted.document(), '記録'), '記録する');
    mounted.key(first, 'Enter');
    await mounted.idle();
    expect(mounted.source()).toBe(LIST);
    const input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    // The paste's write, in the store's queue, answered to the view only once Undo has been chosen (a slow disk): the
    // store runs Undo after it, so Undo takes the paste back while the view is still in the paste's save.
    const applyOver = mounted.store.applyOver.bind(mounted.store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const spy = vi.spyOn(mounted.store, 'applyOver').mockImplementationOnce(async (...args) => {
      const write = applyOver(...args);
      held = true;
      await gate;
      return write;
    });
    paste(mounted.canvas, [image()]);
    for (let round = 0; round < 20 && !held; round += 1) await mounted.settle();
    expect(held).toBe(true);
    // Undo is chosen from the menu (the earlier step keeps it enabled); the store runs it after the paste, so it takes the paste back.
    mounted.canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 700 }));
    const undo = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
      .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === t().undo);
    if (!undo) throw new Error('No Undo item');
    undo.click();
    await mounted.settle();
    release();
    spy.mockRestore();
    await mounted.idle();
    expect(mounted.source()).toBe(LIST);
    expect(mounted.editor()).toBe(input);
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe('');
    expect(mounted.source()).toBe(LIST.replace('- 学ぶこと\n', '- 学ぶこと（編集）\n'));
  });
});

// Pins, not regressions (they pass with the fix reverted: LEV-141 changed nothing on this path). They fix the reading the
// real clipboard takes, which every earlier check skipped by dispatching on the canvas: the event starts in the draft's
// textarea, nothing there prevents it, and the map reads the selected node (the one being edited). E77 takes the OS clipboard.
describe('4. a paste that happens in the draft reaches the map from the textarea (LEV-141)', () => {
  const LIST = ['---', 'mappy: true', '---', '## 計画', '', '- 学ぶこと', '- 記録する', ''].join('\n');
  const paste = (target: EventTarget, files: File[], text: string): Event => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: (type: string) => (type === 'text/plain' ? text : '') } });
    target.dispatchEvent(event);
    return event;
  };
  const image = (): File => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });

  it('an image: attached to the node being edited, and the draft keeps the typed text and applies', async () => {
    const mounted = await mount(LIST);
    const input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    const event = paste(input, [image()], '');
    expect(event.defaultPrevented).toBe(true);
    await mounted.idle();
    expect(mounted.source()).toContain('- 学ぶこと\n\n  ![[1-shot.png]]');
    expect(mounted.editor()).toBe(input);
    expect(input.value).toBe('学ぶこと（編集）');
    mounted.key(input, 'Enter');
    await mounted.idle();
    expect(mounted.error()).toBe('');
    expect(mounted.source()).toContain('- 学ぶこと（編集）\n\n  ![[1-shot.png]]');
  });

  it('text only: the map leaves it to the textarea', async () => {
    const mounted = await mount(LIST);
    const input = await mounted.draft(find(mounted.document(), '学ぶこと'), '学ぶこと（編集）');
    const event = paste(input, [], '貼った文字');
    expect(event.defaultPrevented).toBe(false);
    await mounted.idle();
    expect(mounted.source()).toBe(LIST);
  });
});
