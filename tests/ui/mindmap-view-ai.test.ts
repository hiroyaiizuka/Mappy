// @vitest-environment jsdom
/**
 * マップの AI、案 A（LEV-271、docs/architecture.md §11.5）。UI は `AiRunner` しか知らないので、ここでは決まった進み具合と
 * 結果を返す偽のランナーで回す（本物のランナー LEV-270 とは merge のあとでつなぐ）。
 *
 * 行列は本人の操作（AI ボタン・⌘↵・取り消す・残す・やり直す・捨てる・⌘Z／⌘⇧Z）× 対象の形（リストの項目・見出し・
 * フリートピック・H5／H6・仮想ルート・呼び出したマップ・同名のノード）× 割り込み（日本語の変換中・保存中・インライン入力中・
 * 外部変更〔ノードが残る・消える〕・ノードの移動・別の view・view を閉じる）。下書きはノートにも `localStorage` にも書かない。
 * 寸法・点線の見た目・カードの位置はブラウザ検証ページ（`ai-*`）で見る。jsdom は寸法を持たない。
 */
import type { App, TFile } from 'obsidian';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessApp } from '../browser-harness/app';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice } from '../browser-harness/obsidian';
import type { AiProgress, AiRequest, AiResult, AiRunner } from '../../src/ai/contract';
import { DocumentStore } from '../../src/obsidian/document-store';
import { t } from '../../src/i18n';
import { FakeRunner } from '../../src/ui/ai/fake-runner';
import { aiRunLock, type AiEntitlementView, type AiServices } from '../../src/ui/ai/services';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const PATH = 'Fixtures/ai.md';
const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');
const HEADINGS = ['# 企画', '', '## 背景', '', '本文', '', '## 後', ''].join('\n');

/** A runner the test finishes by hand: what it was asked, the progress callback, and the signal. */
class HandRunner implements AiRunner {
  readonly calls: { request: AiRequest; progress: (progress: AiProgress) => void; signal: AbortSignal; finish: (result: AiResult) => void }[] = [];

  run(request: AiRequest, progress: (progress: AiProgress) => void, signal: AbortSignal): Promise<AiResult> {
    return new Promise(resolve => {
      signal.addEventListener('abort', () => { resolve({ kind: 'cancelled' }); });
      this.calls.push({ request, progress, signal, finish: resolve });
    });
  }

  last(): HandRunner['calls'][number] {
    const call = this.calls.at(-1);
    if (!call) throw new Error('The runner was not called');
    return call;
  }
}

const OUTLINE: AiResult = {
  kind: 'outline', dropped: 0, raw: '- 案 A\n  - 詳細\n- 案 B',
  items: [{ text: '案 A', children: [{ text: '詳細', children: [] }] }, { text: '案 B', children: [] }],
};

interface Services extends AiServices { set: (state: AiEntitlementView) => void; refreshTo: AiEntitlementView | null }

function services(runner: AiRunner, initial: AiEntitlementView = { kind: 'active' }, fakeRunner?: AiRunner): Services {
  let state = initial;
  const listeners = new Set<() => void>();
  const result: Services = {
    refreshTo: null,
    state: () => state,
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => {
      if (result.refreshTo) state = result.refreshTo;
      return Promise.resolve(state);
    },
    createRunner: () => state.kind === 'active' ? runner : null,
    defaultEngine: () => 'claude',
    readAttachment: (file: TFile) => Promise.resolve({ kind: file.extension === 'pdf' ? 'pdf' : 'note', label: file.path, text: `本文 ${file.path}` }),
    set: next => { state = next; for (const listener of listeners) listener(); },
    ...(fakeRunner ? { fakeRunner } : {}),
  };
  return result;
}

interface Mounted extends MountedMapView {
  store: DocumentStore;
  aiButton: () => HTMLButtonElement;
  card: () => HTMLElement;
  /** Press the AI button on the selected node and wait for the input. */
  open: () => Promise<HTMLTextAreaElement>;
  /**
   * ⌘↵ in the input. An empty request is first given `question` (質問, the default template, refuses an empty one:
   * 本人の決定 2026-10-02); `null` leaves it empty.
   */
  run: (init?: KeyboardEventInit, question?: string | null) => Promise<void>;
  draftLabels: () => string[];
  press: (label: string) => Promise<void>;
}

async function mount(source: string, ai: AiServices | null, options: { app?: HarnessApp; store?: DocumentStore } = {}): Promise<Mounted> {
  const app = options.app ?? new HarnessApp();
  if (!options.store) app.put(PATH, source);
  const store = options.store ?? new DocumentStore(app.asApp<App>());
  const mounted = await mountMapView(PATH, source, 'mindmap', app, { store, prepare: view => { view.setAi(ai); } });
  const aiButton = (): HTMLButtonElement => {
    const button = mounted.view.containerEl.querySelector<HTMLButtonElement>('.mappy-ai-button');
    if (!button) throw new Error('No AI button');
    return button;
  };
  const card = (): HTMLElement => {
    const element = mounted.view.containerEl.querySelector<HTMLElement>('.mappy-ai-card');
    if (!element) throw new Error('No AI card');
    return element;
  };
  const press = async (label: string): Promise<void> => {
    const button = Array.from(card().querySelectorAll('button')).find(item => item.textContent === label);
    if (!button) throw new Error(`No button ${label} on the card: ${card().textContent ?? ''}`);
    button.click();
    await mounted.settle();
  };
  return {
    ...mounted, store, aiButton, card, press,
    open: async () => {
      aiButton().click();
      await mounted.settle();
      const input = card().querySelector<HTMLTextAreaElement>('textarea.mappy-ai-instruction');
      if (!input) throw new Error('The input did not open');
      return input;
    },
    run: async (init = {}, question = 'この旅行で決めることは？') => {
      const input = card().querySelector<HTMLTextAreaElement>('textarea.mappy-ai-instruction');
      if (!input) throw new Error('No input');
      if (question !== null && input.value === '') input.value = question;
      mounted.key(input, 'Enter', { metaKey: true, ...init });
      await mounted.settle();
    },
    draftLabels: () => Array.from(mounted.view.containerEl.querySelectorAll('.mappy-node.mappy-ai-draft'), element => element.textContent ?? ''),
  };
}

const field = <T extends HTMLElement>(mounted: Mounted, name: string): T => {
  const element = mounted.card().querySelector<T>(`[data-ai-field="${name}"]`);
  if (!element) throw new Error(`No field ${name}`);
  return element;
};

describe('the AI button (LEV-271)', () => {
  it('shows beside the selected node only while the license is active, expired or unreachable', async () => {
    const ai = services(new HandRunner(), { kind: 'unregistered' });
    const mounted = await mount(LIST, ai);
    mounted.select('温泉旅行');
    expect(mounted.aiButton().hidden).toBe(true);
    for (const kind of ['active', 'expired', 'unreachable'] as const) {
      ai.set({ kind });
      expect(mounted.aiButton().hidden, kind).toBe(false);
    }
    for (const kind of ['checking', 'unregistered', 'invalid'] as const) {
      ai.set({ kind });
      expect(mounted.aiButton().hidden, kind).toBe(true);
    }
  });

  it('is not there at all without services', async () => {
    const mounted = await mount(LIST, null);
    mounted.select('温泉旅行');
    expect(mounted.aiButton().hidden).toBe(true);
  });

  it('refreshes an expired license first and opens the input once it is active', async () => {
    const ai = services(new HandRunner(), { kind: 'expired' });
    const mounted = await mount(LIST, ai);
    mounted.select('温泉旅行');
    ai.refreshTo = { kind: 'unreachable', reason: 'オフライン' };
    mounted.aiButton().click();
    await mounted.settle();
    expect(mounted.card().hidden).toBe(true);
    expect(Notice.log).toContain(t().aiUnavailable('オフライン'));
    ai.refreshTo = { kind: 'active' };
    await mounted.open();
    expect(mounted.card().hidden).toBe(false);
  });

  it('does not show on a sixth-level heading, and an H5 offers one level', async () => {
    const source = '# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6\n';
    const mounted = await mount(source, services(new HandRunner()));
    mounted.select('6');
    expect(mounted.aiButton().hidden).toBe(true);
    mounted.select('5');
    expect(mounted.aiButton().hidden).toBe(false);
    await mounted.open();
    expect(Array.from(field<HTMLSelectElement>(mounted, 'depth').options, option => option.value)).toEqual(['1']);
  });

  it('on the virtual root (a list before any H2) says to add an H2 first instead of opening', async () => {
    const mounted = await mount('- 項目\n  - 子\n', services(new HandRunner()));
    // The file name is the virtual root's title.
    mounted.select('ai');
    expect(mounted.aiButton().hidden).toBe(false);
    expect(mounted.aiButton().getAttribute('aria-disabled')).toBe('true');
    mounted.aiButton().click();
    await mounted.settle();
    expect(Notice.log).toContain(t().aiAddH2First);
    expect(mounted.card().hidden).toBe(true);
  });

  it('does not show on a called map\'s node or the item calling it', async () => {
    const app = new HarnessApp();
    app.put('Fixtures/called.md', '---\nmappy: true\n---\n## 呼ばれる\n\n- 中身\n');
    const host = '## ホスト\n\n- ![[called]]\n- 自分の項目\n';
    const mounted = await mount(host, services(new HandRunner()), { app });
    await mounted.settle();
    mounted.select('自分の項目');
    expect(mounted.aiButton().hidden).toBe(false);
    mounted.select('中身');
    expect(mounted.aiButton().hidden).toBe(true);
    mounted.select('呼ばれる');
    expect(mounted.aiButton().hidden).toBe(true);
  });
});

describe('the input', () => {
  // 本人の決定 2026-10-02: the first entrance shown is 質問からマップ (no material, no tool), on every node, a URL's,
  // a PDF's and a video's included; their summary is chosen on the list.
  it('opens on a question on every node: 質問 first on the list, the request empty and focused, no web search, no attachment', async () => {
    const source = ['## 資料', '', '- https://www.youtube.com/watch?v=abc123', '- [[資料.pdf]]', '- [記事](https://example.com/a)', '- 普通の項目', ''].join('\n');
    const mounted = await mount(source, services(new HandRunner()));
    for (const title of ['https://www.youtube.com/watch?v=abc123', '[[資料.pdf]]', '[記事](https://example.com/a)', '普通の項目']) {
      mounted.select(title);
      const input = await mounted.open();
      const templates = field<HTMLSelectElement>(mounted, 'template');
      expect(templates.value, title).toBe('free');
      expect(templates.options[0]?.textContent, title).toBe(t().aiTemplateFree);
      expect(input.value, title).toBe('');
      expect(input.placeholder, title).toBe(t().aiInstructionPlaceholder);
      expect(document.activeElement, title).toBe(input);
      expect(field<HTMLInputElement>(mounted, 'web-search').checked, title).toBe(false);
      expect(mounted.card().querySelector('.mappy-ai-attachment'), title).toBeNull();
      mounted.key(input, 'Escape');
      await mounted.settle();
      expect(mounted.card().hidden).toBe(true);
    }
  });

  it('does not run on ⌘↵ while the IME composes, and runs on ⌘↵ after it (E01)', async () => {
    const runner = new HandRunner();
    const mounted = await mount(LIST, services(runner));
    mounted.select('温泉旅行');
    const input = await mounted.open();
    input.value = 'へんかん';
    await mounted.run({ isComposing: true });
    mounted.key(input, 'Process', { metaKey: true });
    await mounted.settle();
    expect(runner.calls).toHaveLength(0);
    expect(mounted.card().querySelector('textarea')).not.toBeNull();
    await mounted.run();
    expect(runner.calls).toHaveLength(1);
    expect(runner.last().request).toMatchObject({
      engine: 'claude', template: 'free', instruction: 'へんかん', depth: 2, webSearch: false,
      context: { ancestors: ['ai', '旅の計画'], title: '温泉旅行', body: '' }, materials: [],
    });
  });

  it('refuses an empty question under 質問, and sends the chosen template, depth, engine, web search and attachments', async () => {
    const runner = new HandRunner();
    const app = new HarnessApp();
    app.put('資料/メモ.md', '# メモ\n');
    const mounted = await mount(LIST, services(runner), { app });
    mounted.select('持ち物');
    await mounted.open();
    expect(field<HTMLSelectElement>(mounted, 'template').value).toBe('free');
    await mounted.run({}, null);
    expect(runner.calls).toHaveLength(0);
    expect(mounted.card().textContent).toContain(t().aiInstructionNeeded);
    field<HTMLTextAreaElement>(mounted, 'instruction').value = '比べて';
    field<HTMLSelectElement>(mounted, 'depth').value = '3';
    field<HTMLSelectElement>(mounted, 'engine').value = 'codex';
    field<HTMLInputElement>(mounted, 'web-search').checked = true;
    await mounted.run();
    expect(runner.last().request).toMatchObject({ engine: 'codex', template: 'free', instruction: '比べて', depth: 3, webSearch: true });
  });

  it('offers the fake engine only when the services give one, and runs it instead of the CLI', async () => {
    const plain = await mount(LIST, services(new HandRunner()));
    plain.select('持ち物');
    await plain.open();
    expect(Array.from(field<HTMLSelectElement>(plain, 'engine').options, option => option.value)).toEqual(['claude', 'codex']);
    await closeOpenViews();
    const cli = new HandRunner();
    const fake = new FakeRunner({ interval: 0 });
    const mounted = await mount(LIST, services(cli, { kind: 'active' }, fake));
    mounted.select('持ち物');
    await mounted.open();
    field<HTMLSelectElement>(mounted, 'engine').value = 'fake';
    await mounted.run();
    await new Promise(resolve => setTimeout(resolve, 20));
    await mounted.settle();
    expect(cli.calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
    expect(mounted.draftLabels()).toHaveLength(fake.requests.length * 9);
  });
});

describe('a run', () => {
  it('shows its progress and 取り消す, and is the only run in Mappy meanwhile', async () => {
    const runner = new HandRunner();
    const ai = services(runner);
    const mounted = await mount(LIST, ai);
    const other = await mount(LIST, ai, { app: mounted.app, store: mounted.store });
    mounted.select('温泉旅行');
    await mounted.open();
    await mounted.run();
    expect(mounted.card().textContent).toContain(t().aiStageStarting);
    runner.last().progress({ stage: 'searching', query: '温泉 予約' });
    expect(mounted.card().textContent).toContain(t().aiStageSearching('温泉 予約'));
    // This view's button waits for the run; the other view's says another run is under way.
    expect(mounted.aiButton().hidden).toBe(true);
    other.select('持ち物');
    expect(other.aiButton().getAttribute('aria-disabled')).toBe('true');
    other.aiButton().click();
    await other.settle();
    expect(Notice.log).toContain(t().aiBusy);
    await mounted.press(t().aiCancel);
    expect(runner.last().signal.aborted).toBe(true);
    expect(Notice.log).toContain(t().aiCancelled);
    expect(aiRunLock.busy()).toBe(false);
    expect(other.aiButton().getAttribute('aria-disabled')).toBe('false');
    expect(mounted.source()).toBe(LIST);
  });

  it('shows a refusal and a failure with their raw output under 詳細, and やり直す runs the same input again', async () => {
    const runner = new HandRunner();
    const mounted = await mount(LIST, services(runner));
    mounted.select('温泉旅行');
    const input = await mounted.open();
    input.value = '要約して';
    await mounted.run();
    runner.last().finish({ kind: 'refused', reason: '字幕が無い', raw: '- 取得できませんでした: 字幕が無い' });
    await mounted.settle();
    expect(mounted.card().textContent).toContain(t().aiRefused('字幕が無い'));
    await mounted.press(t().aiDetails);
    expect(mounted.card().querySelector('pre')?.textContent).toBe('- 取得できませんでした: 字幕が無い');
    await mounted.press(t().aiRetry);
    expect(runner.calls).toHaveLength(2);
    expect(runner.last().request.instruction).toBe('要約して');
    runner.last().finish({ kind: 'failed', reason: 'not-logged-in', detail: 'Please run /login' });
    await mounted.settle();
    expect(mounted.card().textContent).toContain(t().aiFailureNotLoggedIn);
    await mounted.press(t().aiDetails);
    expect(mounted.card().querySelector('pre')?.textContent).toBe('Please run /login');
    expect(mounted.source()).toBe(LIST);
  });
});

describe('the draft', () => {
  async function drafted(source: string, title: string, result: AiResult = OUTLINE): Promise<Mounted & { runner: HandRunner }> {
    const runner = new HandRunner();
    const mounted = await mount(source, services(runner));
    mounted.select(title);
    await mounted.open();
    await mounted.run();
    runner.last().finish(result);
    await mounted.settle();
    return { ...mounted, runner };
  }

  it('shows the result as dotted nodes under the node, in neither the note nor localStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const mounted = await drafted(LIST, '温泉旅行');
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    expect(mounted.card().textContent).toContain(t().aiDraftCount(3));
    expect(mounted.source()).toBe(LIST);
    expect(setItem).not.toHaveBeenCalled();
    // The draft's nodes are not the map's: they are not selectable nodes and do not take keys.
    expect(mounted.view.containerEl.querySelector('.mappy-ai-draft[data-node-id]')).toBeNull();
    setItem.mockRestore();
  });

  it('opens a folded node to show the draft under it', async () => {
    const runner = new HandRunner();
    const mounted = await mount(LIST, services(runner));
    const toggle = mounted.node('温泉旅行').querySelector<HTMLElement>('.mappy-node-toggle');
    toggle?.click();
    await mounted.settle();
    expect(() => mounted.node('予約')).toThrow();
    mounted.select('温泉旅行');
    await mounted.open();
    await mounted.run();
    runner.last().finish(OUTLINE);
    await mounted.settle();
    expect(mounted.node('予約')).toBeTruthy();
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
  });

  const KEPT: [string, string, string, string][] = [
    ['リストの項目', LIST, '温泉旅行', LIST.replace('  - 予約\n', '  - 予約\n  - 案 A\n    - 詳細\n  - 案 B\n')],
    ['見出し', HEADINGS, '背景', HEADINGS.replace('本文\n\n', '本文\n\n### 案 A\n\n#### 詳細\n\n### 案 B\n\n')],
    ['見出しのフリートピック', '# 本体\n\n# 別\n', '別', '# 本体\n\n# 別\n\n## 案 A\n\n### 詳細\n\n## 案 B\n'],
    ['リスト形式のフリートピック', '## 本体\n\n- 子\n\n## 別\n', '別', '## 本体\n\n- 子\n\n## 別\n\n- 案 A\n  - 詳細\n- 案 B\n'],
  ];
  for (const [shape, source, title, written] of KEPT) {
    it(`残す writes it as one step: ${shape}, ⌘Z takes all of it back and ⌘⇧Z brings all of it again`, async () => {
      const mounted = await drafted(source, title);
      await mounted.press(t().aiKeep);
      expect(mounted.source()).toBe(written);
      expect(mounted.draftLabels()).toEqual([]);
      expect(mounted.card().hidden).toBe(true);
      expect(mounted.node('案 A')).toBeTruthy();
      mounted.key(mounted.canvas, 'z', { metaKey: true });
      await mounted.settle();
      expect(mounted.source()).toBe(source);
      mounted.key(mounted.canvas, 'z', { metaKey: true, shiftKey: true });
      await mounted.settle();
      expect(mounted.source()).toBe(written);
    });
  }

  it('lifts levels past H6 on an H5 before it writes them', async () => {
    const source = '# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n';
    const mounted = await drafted(source, '5');
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe(`${source}\n###### 案 A\n\n###### 詳細\n\n###### 案 B\n`);
  });

  it('keeps the ids of same-titled and empty nodes through 残す (the folds stay where they were)', async () => {
    const source = ['## R', '', '- 同じ', '  - 子 1', '- 同じ', '  - 子 2', '- ', '  - 空の子', ''].join('\n');
    const runner = new HandRunner();
    const mounted = await mount(source, services(runner));
    const sames = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(element => element.textContent?.startsWith('同じ'));
    const second = sames[1];
    if (!second) throw new Error('No second node');
    const secondId = second.dataset.nodeId;
    second.querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await mounted.settle();
    expect(() => mounted.node('子 2')).toThrow();
    sames[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await mounted.open();
    await mounted.run();
    runner.last().finish(OUTLINE);
    await mounted.settle();
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe(source.replace('  - 子 1\n', '  - 子 1\n  - 案 A\n    - 詳細\n  - 案 B\n'));
    // The second 「同じ」 kept its id, and with it its fold.
    expect(mounted.view.containerEl.querySelector(`.mappy-node[data-node-id="${secondId ?? ''}"]`)).not.toBeNull();
    expect(() => mounted.node('子 2')).toThrow();
  });

  it('writes the result inert when an item reads as markup', async () => {
    const mounted = await drafted(LIST, '持ち物', {
      kind: 'outline', dropped: 1, raw: '',
      items: [{ text: '- 論点', children: [] }, { text: '途中 %% 隠す', children: [] }, { text: '---', children: [] }],
    });
    expect(mounted.card().textContent).toContain(t().aiDropped(1));
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe(LIST.replace('- 持ち物\n', '- 持ち物\n  - \\- 論点\n  - 途中 \\%\\% 隠す\n  - \\---\n'));
  });

  it('is not dropped when 残す does not write (a save under way), and the next 残す writes it', async () => {
    const mounted = await drafted(LIST, '温泉旅行');
    (mounted.view as unknown as { saving: boolean }).saving = true;
    await mounted.press(t().aiKeep);
    (mounted.view as unknown as { saving: boolean }).saving = false;
    expect(mounted.source()).toBe(LIST);
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    expect(mounted.card().textContent).toContain(t().aiKeepFailed(t().savingWait));
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe(LIST.replace('  - 予約\n', '  - 予約\n  - 案 A\n    - 詳細\n  - 案 B\n'));
  });

  it('confirms an open inline draft first, then writes, when 残す is pressed mid-edit', async () => {
    const mounted = await drafted(LIST, '温泉旅行');
    mounted.node('持ち物').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await mounted.settle();
    const input = mounted.editor();
    if (!input) throw new Error('No inline editor');
    input.value = '持ち物リスト';
    await mounted.press(t().aiKeep);
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('  - 予約\n', '  - 予約\n  - 案 A\n    - 詳細\n  - 案 B\n').replace('- 持ち物\n', '- 持ち物リスト\n'));
    expect(mounted.editor()).toBeNull();
    expect(mounted.draftLabels()).toEqual([]);
  });

  it('stays with its reason when 残す meets a change the map has not read (ConflictError), and writes on the next 残す', async () => {
    const mounted = await drafted(LIST, '温泉旅行');
    const external = LIST.replace('- 持ち物\n', '- 持ち物\n- 外から\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, external);
    silent.mockRestore();
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe(external);
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    expect(mounted.card().textContent).toContain(t().aiKeepFailed(t().conflict));
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe(external.replace('  - 予約\n', '  - 予約\n  - 案 A\n    - 詳細\n  - 案 B\n'));
  });

  it('follows its node through an external change and a move, and closes with a copy Notice once the node is gone', async () => {
    const mounted = await drafted(LIST, '持ち物');
    mounted.app.put(PATH, LIST.replace('## 旅の計画\n', '## 旅の計画\n\n- 先頭に追加\n'));
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    mounted.key(mounted.select('持ち物'), 'ArrowUp', { altKey: true });
    await mounted.settle();
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    mounted.app.put(PATH, '---\nmappy: true\n---\n## 旅の計画\n\n- 温泉旅行\n');
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
    expect(mounted.draftLabels()).toEqual([]);
    expect(Notice.log).toContain(t().aiAnchorGone + t().aiCopy);
    expect(mounted.card().hidden).toBe(true);
  });

  it('is this view\'s only: another view of the note shows none, and sees what 残す wrote', async () => {
    const runner = new HandRunner();
    const ai = services(runner);
    const mounted = await mount(LIST, ai);
    const other = await mount(LIST, ai, { app: mounted.app, store: mounted.store });
    mounted.select('温泉旅行');
    await mounted.open();
    await mounted.run();
    runner.last().finish(OUTLINE);
    await mounted.settle();
    expect(mounted.draftLabels()).toHaveLength(3);
    expect(other.draftLabels()).toEqual([]);
    await mounted.press(t().aiKeep);
    await new Promise(resolve => setTimeout(resolve, 60));
    await other.settle();
    expect(other.node('案 A')).toBeTruthy();
    expect(other.draftLabels()).toEqual([]);
  });

  it('やり直す keeps the draft until the next run succeeds; 捨てる leaves the note as it was', async () => {
    const mounted = await drafted(LIST, '温泉旅行');
    await mounted.press(t().aiRetry);
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    mounted.runner.last().finish({ kind: 'failed', reason: 'timeout', detail: '' });
    await mounted.settle();
    expect(mounted.draftLabels()).toEqual(['案 A', '詳細', '案 B']);
    expect(mounted.card().textContent).toContain(t().aiFailureTimeout);
    await mounted.press(t().aiRetry);
    mounted.runner.last().finish({ kind: 'outline', dropped: 0, raw: '', items: [{ text: '別の案', children: [] }] });
    await mounted.settle();
    expect(mounted.draftLabels()).toEqual(['別の案']);
    await mounted.press(t().aiDiscard);
    expect(mounted.draftLabels()).toEqual([]);
    expect(mounted.card().hidden).toBe(true);
    expect(mounted.source()).toBe(LIST);
  });

  it('refuses the export while it is on the map', async () => {
    const mounted = await drafted(LIST, '温泉旅行');
    await expect(mounted.view.exportSource()).rejects.toThrow(t().exportAiDraft);
  });

  it('goes with the view, and a run under way is cancelled', async () => {
    const runner = new HandRunner();
    const mounted = await mount(LIST, services(runner));
    mounted.select('温泉旅行');
    await mounted.open();
    await mounted.run();
    await mounted.close();
    expect(runner.last().signal.aborted).toBe(true);
    expect(aiRunLock.busy()).toBe(false);
    expect(mounted.source()).toBe(LIST);
  });
});

/** The findings of the code review (`/code-review high origin/feature/ai...HEAD`, 2026-10-02), one row each. */
describe('the draft and the card after the code review', () => {
  async function drafted(source: string, title: string, result: AiResult = OUTLINE, depth?: string): Promise<Mounted & { runner: HandRunner }> {
    const runner = new HandRunner();
    const mounted = await mount(source, services(runner));
    mounted.select(title);
    await mounted.open();
    if (depth) field<HTMLSelectElement>(mounted, 'depth').value = depth;
    await mounted.run();
    runner.last().finish(result);
    await mounted.settle();
    return { ...mounted, runner };
  }
  const visibleDraft = (mounted: Mounted): string[] => Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-ai-draft'))
    .filter(element => !element.hidden).map(element => element.textContent ?? '');

  it('hides the draft with its node when a fold above the node closes, and shows it again when it opens', async () => {
    const source = ['## R', '', '- 親', '  - 子', ''].join('\n');
    const mounted = await drafted(source, '子');
    expect(visibleDraft(mounted)).toEqual(['案 A', '詳細', '案 B']);
    const toggle = (): void => { mounted.node('親').querySelector<HTMLElement>('.mappy-node-toggle')?.click(); };
    toggle();
    await mounted.settle();
    expect(visibleDraft(mounted)).toEqual([]);
    toggle();
    await mounted.settle();
    expect(visibleDraft(mounted)).toEqual(['案 A', '詳細', '案 B']);
  });

  it('leaves the focus on 捨てる (and the button itself) through a redraw that changes nothing on the card', async () => {
    const runner = new HandRunner();
    const ai = services(runner);
    const mounted = await mount(LIST, ai);
    mounted.select('温泉旅行');
    await mounted.open();
    await mounted.run();
    runner.last().finish(OUTLINE);
    await mounted.settle();
    const discard = Array.from(mounted.card().querySelectorAll('button')).find(button => button.textContent === t().aiDiscard);
    discard?.focus();
    // A license change, another view's run starting and ending, and a layout frame: none of them changes the card.
    ai.set({ kind: 'active' });
    const elsewhere = {};
    aiRunLock.take(elsewhere);
    aiRunLock.release(elsewhere);
    (mounted.view as unknown as { scheduleLayout: () => void }).scheduleLayout();
    await mounted.settle();
    expect(document.activeElement).toBe(discard);
    expect(discard?.isConnected).toBe(true);
  });

  it('keeps what was typed when the run is refused (another view\'s run holds the lock)', async () => {
    const runner = new HandRunner();
    const ai = services(runner);
    const mounted = await mount(LIST, ai);
    const other = await mount(LIST, ai, { app: mounted.app, store: mounted.store });
    mounted.select('温泉旅行');
    const input = await mounted.open();
    input.value = '長い頼みごと';
    other.select('持ち物');
    await other.open();
    await other.run();
    await mounted.run();
    expect(Notice.log).toContain(t().aiBusy);
    expect(runner.calls).toHaveLength(1);
    expect(mounted.card().hidden).toBe(false);
    expect(field<HTMLTextAreaElement>(mounted, 'instruction').value).toBe('長い頼みごと');
    runner.last().finish({ kind: 'cancelled' });
    await other.settle();
  });

  it('closes a failure whose node is gone', async () => {
    const mounted = await drafted(LIST, '持ち物', { kind: 'failed', reason: 'timeout', detail: '' });
    expect(mounted.card().textContent).toContain(t().aiFailureTimeout);
    mounted.app.put(PATH, LIST.replace('- 持ち物\n', ''));
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
    expect(mounted.card().hidden).toBe(true);
  });

  it('opens nothing when the selection moved while an expired license was refreshed', async () => {
    let release: (state: AiEntitlementView) => void = () => undefined;
    const ai = services(new HandRunner(), { kind: 'expired' });
    ai.refresh = () => new Promise(resolve => { release = resolve; });
    const mounted = await mount(LIST, ai);
    mounted.select('温泉旅行');
    mounted.aiButton().click();
    await mounted.settle();
    mounted.select('持ち物');
    ai.state = () => ({ kind: 'active' });
    release({ kind: 'active' });
    await mounted.settle();
    expect(mounted.card().hidden).toBe(true);
  });

  it('lifts a result deeper than the depth asked for to that depth', async () => {
    const deep: AiResult = { kind: 'outline', dropped: 0, raw: '', items: [{ text: 'a', children: [{ text: 'b', children: [{ text: 'c', children: [] }] }] }] };
    const mounted = await drafted(LIST, '持ち物', deep, '1');
    expect(mounted.draftLabels()).toEqual(['a', 'b', 'c']);
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe(LIST.replace('- 持ち物\n', '- 持ち物\n  - a\n  - b\n  - c\n'));
  });

  it('fits the draft again to the node as it is when 残す is pressed (an H3 that became an H5)', async () => {
    const source = '# A\n\n## B\n\n### X\n';
    const deep: AiResult = { kind: 'outline', dropped: 0, raw: '', items: [{ text: 'a', children: [{ text: 'b', children: [{ text: 'c', children: [] }] }] }] };
    const mounted = await drafted(source, 'X', deep, '3');
    expect(mounted.draftLabels()).toEqual(['a', 'b', 'c']);
    mounted.app.put(PATH, '# A\n\n## B\n\n### C\n\n#### D\n\n##### X\n');
    await new Promise(resolve => setTimeout(resolve, 60));
    await mounted.settle();
    expect(mounted.draftLabels()).toEqual(['a', 'b', 'c']);
    await mounted.press(t().aiKeep);
    expect(mounted.source()).toBe('# A\n\n## B\n\n### C\n\n#### D\n\n##### X\n\n###### a\n\n###### b\n\n###### c\n');
  });

  it('closes a failure on Escape and gives the keys back to the map', async () => {
    const mounted = await drafted(LIST, '持ち物', { kind: 'failed', reason: 'timeout', detail: '' });
    const retry = Array.from(mounted.card().querySelectorAll('button')).find(button => button.textContent === t().aiRetry);
    retry?.focus();
    mounted.key(retry ?? mounted.card(), 'Escape');
    await mounted.settle();
    expect(mounted.card().hidden).toBe(true);
    expect(mounted.canvas.contains(document.activeElement)).toBe(true);
  });
});
