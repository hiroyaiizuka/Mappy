// @vitest-environment jsdom
/**
 * docs/architecture.md §11.7, step 2 (LEV-273; product-plan §5 M9's acceptance「無料状態で AI 関連のコードが外部
 * 〔Workers・CLI〕に触れない〔本人の登録操作を除く〕」): the real plugin, unregistered, through `onload`, a map opened
 * and edited, the settings tab on both of Obsidian's paths, every command and the ribbon, reaches neither the
 * license server (`requestUrl`) nor Node (`window.require`, the one way `loadNode()` takes Node, §11.1). Pressing
 * the settings' register button is the one request, and it reaches no Node either.
 *
 * The counter stands on the `window.require` that `loadNode()` (LEV-270) reads. Since the wiring (§11.8, LEV-270
 * merged third) the plugin's runner factory, its settings rows and the map's AI button (LEV-271) are all in this
 * path: with the license unregistered, `runnerFactory.create()` and the services' `createRunner()` give null, no AI
 * button is shown, and Node is never read. Making the factory ignore the license (`isEntitled: () => true` in
 * main.ts) reads Node at once (artifacts/lev-270/reverts.log, X1).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Command, PluginManifest, ViewCreator, WorkspaceLeaf as ObsidianLeaf } from 'obsidian';
import { HarnessApp } from '../browser-harness/app';
import { installObsidianDom } from '../browser-harness/dom';
import { WorkspaceLeaf, type PluginSettingTab as HarnessSettingTab } from '../browser-harness/obsidian';
import { allowsAiRunner, showsAiButton, type Entitlement } from '../../src/ai/license/entitlement';
import { LICENSE_STORAGE_KEY } from '../../src/ai/license/store';
import { MindmapView, VIEW_TYPE } from '../../src/ui/mindmap-view';
import { closeOpenViews } from '../mocks/open-views';
import { accessibleName } from '../ui/accessible-name';

const outside = vi.hoisted(() => ({
  requests: [] as unknown[],
  answer: (): Promise<unknown> => Promise.reject(new Error('offline')),
}));

/** The plugin base as Obsidian's (the parts onload uses), keeping what was registered so the test can run it. */
vi.mock('obsidian', async () => {
  const harness = await import('../browser-harness/obsidian');
  class Plugin extends harness.Component {
    readonly commands: Command[] = [];
    readonly ribbon: (() => unknown)[] = [];
    readonly views = new Map<string, ViewCreator>();
    readonly settingTabs: unknown[] = [];
    data: unknown = null;
    constructor(readonly app: App, readonly manifest: PluginManifest) { super(); }
    loadData(): Promise<unknown> { return Promise.resolve(this.data); }
    saveData(data: unknown): Promise<void> { this.data = data; return Promise.resolve(); }
    addSettingTab(tab: unknown): void { this.settingTabs.push(tab); }
    addCommand(command: Command): Command { this.commands.push(command); return command; }
    addRibbonIcon(_icon: string, _title: string, callback: () => unknown): HTMLElement { this.ribbon.push(callback); return document.createElement('div'); }
    registerView(type: string, creator: ViewCreator): void { this.views.set(type, creator); }
    registerHoverLinkSource(): void { /* Page preview: nothing to reach. */ }
    registerMarkdownPostProcessor(): void { /* Embeds render in notes this test does not open. */ }
  }
  return {
    ...harness,
    Plugin,
    getLanguage: () => 'ja',
    requestUrl: (request: unknown) => { outside.requests.push(request); return outside.answer(); },
  };
});

interface TestPlugin {
  app: App;
  commands: Command[];
  ribbon: (() => unknown)[];
  views: Map<string, ViewCreator>;
  settingTabs: unknown[];
  data: unknown;
  entitlement: Entitlement;
  runnerFactory: { create(): unknown; availability(): string };
  aiServices: { createRunner(): unknown; defaultEngine(): string };
  load(): void;
  unload(): void;
  onload(): Promise<void>;
}

let nodeReads = 0;
beforeAll(() => {
  installObsidianDom();
  // How loadNode() takes Node (§11.1): every read of window.require is one reach for Node.
  Object.defineProperty(window, 'require', { configurable: true, get: () => { nodeReads += 1; return undefined; } });
});

beforeEach(() => {
  nodeReads = 0;
  outside.requests.length = 0;
  window.localStorage.removeItem(LICENSE_STORAGE_KEY);
});

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
});

const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => requestAnimationFrame(resolve));
};

/** The harness app with the workspace calls the plugin's commands make, answering for the one map the test opens. */
function appWith(harness: HarnessApp, active: () => MindmapView | null): App {
  const workspace = harness.workspace as unknown as Record<string, unknown>;
  workspace.getActiveViewOfType = (type: unknown) => { const view = active(); return view instanceof (type as typeof MindmapView) ? view : null; };
  workspace.getActiveFile = () => active()?.file ?? null;
  workspace.getLeaf = () => new WorkspaceLeaf(harness.asApp());
  workspace.getLeavesOfType = (type: string) => { const view = active(); return type === VIEW_TYPE && view ? [view.leaf] : []; };
  return harness.asApp<App>();
}

async function freePlugin(data: unknown = null) {
  const harness = new HarnessApp();
  harness.put('Map.md', '---\nmappy-layout: mindmap\n---\n# Map\n\n## Topic\n\n- First\n- Second\n');
  let map: MindmapView | null = null;
  const app = appWith(harness, () => map);
  const { default: MappyPlugin } = await import('../../src/main');
  const plugin = new MappyPlugin(app, { id: 'mappy', name: 'Mappy', version: '0.0.0', minAppVersion: '1.8.7', author: '', description: '' }) as unknown as TestPlugin;
  plugin.data = data;
  plugin.load();
  await plugin.onload();
  await settle();
  const openMap = async () => {
    const leaf = new WorkspaceLeaf(harness.asApp());
    const view = plugin.views.get(VIEW_TYPE)?.(leaf as unknown as ObsidianLeaf) as MindmapView;
    leaf.view = view as unknown as WorkspaceLeaf['view'];
    document.body.append(view.containerEl);
    view.load();
    await view.onOpen();
    await view.setState({ file: 'Map.md', layout: 'mindmap' }, { history: false });
    await settle();
    map = view;
    return view;
  };
  return { harness, plugin, openMap };
}

function nodeElement(view: MindmapView, title: string): HTMLElement {
  const found = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).find(element => accessibleName(element) === title);
  if (!found) throw new Error(`No node ${title}`);
  return found;
}

function key(target: EventTarget, value: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
}

// The whole plugin loads and a map lays out: seconds on a loaded machine.
describe('the free state reaches nothing outside (§11.7 step 2)', { timeout: 60_000 }, () => {
  it('onload, a map opened and edited, the settings tab, every command and the ribbon: no license request, no Node', async () => {
    const { plugin, openMap, harness } = await freePlugin();
    const entitlement = plugin.entitlement;
    expect(entitlement.state()).toEqual({ kind: 'unregistered' });

    // A map: open it, select a node, add a child and name it.
    const view = await openMap();
    const canvas = view.containerEl.querySelector<HTMLElement>('.mappy-canvas')!;
    canvas.setPointerCapture = () => undefined;
    canvas.releasePointerCapture = () => undefined;
    canvas.hasPointerCapture = () => false;
    nodeElement(view, 'Topic').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(nodeElement(view, 'Topic'), 'Tab');
    await settle();
    const editor = view.containerEl.querySelector<HTMLTextAreaElement>('textarea.mappy-inline-input');
    if (!editor) throw new Error('Tab opened no title editor');
    editor.value = 'Child';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    key(editor, 'Enter');
    await settle();
    expect(harness.content(view.file!)).toContain('Child');

    // The settings tab, drawn by display() (before 1.13) and by the declarative renderer (1.13+).
    const tab = plugin.settingTabs[0] as HarnessSettingTab & { display(): void };
    document.body.append(tab.containerEl);
    tab.display();
    tab.update();
    tab.renderTab();
    tab.hide();

    // Every command, checked and then run where it applies, and the ribbon.
    expect(plugin.commands.length).toBeGreaterThan(0);
    for (const command of plugin.commands) {
      if (command.checkCallback) {
        if (command.checkCallback(true)) command.checkCallback(false);
      } else {
        command.callback?.();
      }
      await settle();
    }
    for (const click of plugin.ribbon) click();
    await settle();

    expect(outside.requests).toEqual([]);
    expect(nodeReads).toBe(0);
    expect(entitlement.state()).toEqual({ kind: 'unregistered' });
    expect(allowsAiRunner(entitlement.state())).toBe(false);
    expect(showsAiButton(entitlement.state())).toBe(false);
    // The wiring (§11.8): no runner, no shown AI button, and the asking itself reached no Node.
    expect(plugin.runnerFactory.availability()).toBe('not-entitled');
    expect(plugin.runnerFactory.create()).toBeNull();
    expect(plugin.aiServices.createRunner()).toBeNull();
    // The view was given the plugin's services (so a license would show the button), and shows none now.
    expect((view as unknown as { aiServices: unknown }).aiServices).toBe(plugin.aiServices);
    const buttons = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.mappy-ai-button'));
    expect(buttons.every(button => button.hidden)).toBe(true);
    expect(nodeReads).toBe(0);
    expect(window.localStorage.getItem(LICENSE_STORAGE_KEY)).toBeNull();

    plugin.unload();
  });

  it('keeps the AI engine and models in data.json beside the settings, through a settings save', async () => {
    const { plugin } = await freePlugin({ theme: 'follow', ai: { engine: 'codex', claudeModel: 'opus', codexModel: '' } });
    expect(plugin.aiServices.defaultEngine()).toBe('codex');
    const tab = plugin.settingTabs[0] as { setControlValue(key: string, value: unknown): Promise<void> };
    await tab.setControlValue('theme', 'dark');
    expect(plugin.data).toMatchObject({ theme: 'dark', ai: { engine: 'codex', claudeModel: 'opus', codexModel: '' } });
    expect(nodeReads).toBe(0);
    plugin.unload();
  });

  it('the register button is the one request, and it carries the code and a device ID only, reaching no Node', async () => {
    const { plugin } = await freePlugin();
    const tab = plugin.settingTabs[0] as HarnessSettingTab & { display(): void };
    document.body.append(tab.containerEl);
    tab.display();
    expect(outside.requests).toEqual([]);
    const license = Array.from(tab.containerEl.querySelectorAll<HTMLElement>('.setting-item'))
      .find(item => item.querySelector('.setting-item-name')?.textContent === 'ライセンスコード')!;
    const input = license.querySelector<HTMLInputElement>('input')!;
    input.value = 'CODE-1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    license.querySelector<HTMLButtonElement>('button')!.click();
    await settle();
    expect(outside.requests).toHaveLength(1);
    const [request] = outside.requests as { url: string; body: string }[];
    expect(request!.url).toMatch(/\/v1\/register$/u);
    expect(Object.keys(JSON.parse(request!.body) as object).sort()).toEqual(['deviceId', 'licenseCode']);
    expect(nodeReads).toBe(0);
    // Offline: still unregistered, and the row says why.
    expect(plugin.entitlement.state()).toEqual({ kind: 'unregistered' });
    expect(license.querySelector('.mappy-setting-ai-failure')?.textContent).toContain('通信できません');
    plugin.unload();
  });
});
