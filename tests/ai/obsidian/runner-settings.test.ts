// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../browser-harness/dom';
import { Notice } from '../../browser-harness/obsidian';
import { renderRunnerSettings } from '../../../src/ai/obsidian/runner-settings';
import { createRunnerFactory } from '../../../src/ai/runner-factory';
import { DEFAULT_AI_PREFS, EMPTY_PATHS, type AiPrefs, type RunnerPaths } from '../../../src/ai/settings';
import { FakeHost } from '../fake-host';

vi.mock('obsidian', () => import('../../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); Notice.log.length = 0; });

function mount(entitled: boolean, host = new FakeHost({ executables: ['/opt/homebrew/bin/claude'] }), platform = { isDesktopApp: true, isWin: false }) {
  let prefs: AiPrefs = DEFAULT_AI_PREFS;
  let paths: RunnerPaths = EMPTY_PATHS;
  const load = vi.fn(() => host);
  const factory = createRunnerFactory({
    isEntitled: () => entitled, prefs: () => prefs, paths: { current: () => paths, save: next => { paths = next; return true; } },
    language: () => 'ja', platform, load, target: new EventTarget(),
  });
  const prefsSave = vi.fn((next: AiPrefs) => { prefs = next; return Promise.resolve(); });
  const container = document.createElement('div');
  document.body.append(container);
  renderRunnerSettings(container, { factory, prefs: { current: () => prefs, save: prefsSave }, paths: { current: () => paths, save: next => { paths = next; return true; } } });
  return { container, load, host, prefs: () => prefs, paths: () => paths, prefsSave };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const names = (container: HTMLElement) => Array.from(container.querySelectorAll('.setting-item-name')).map(name => name.textContent);

describe('renderRunnerSettings (architecture.md §11.3, §11.7)', () => {
  it('says 「見つかりません」 when the search itself fails (the temporary directory cannot be made)', async () => {
    const host = new FakeHost({ env: { SHELL: '/bin/zsh' } });
    host.mkdtemp = () => Promise.reject(new Error('ENOSPC'));
    const { container } = mount(true, host);
    Array.from(container.querySelectorAll('button')).find(button => button.textContent === '探す')?.click();
    for (let i = 0; i < 20 && Notice.log.length === 0; i++) await flush();
    expect(Notice.log.map(entry => String(entry))).toEqual(['ログインシェルでも claude が見つかりませんでした。']);
  });

  it('draws nothing and touches no Node while the license is off', () => {
    const { container, load } = mount(false);
    expect(container.childElementCount).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('says 「未対応」 on Windows, without Node', () => {
    const { container, load } = mount(true, undefined, { isDesktopApp: true, isWin: true });
    expect(container.textContent).toContain('AI 機能はデスクトップ版でだけ使えます（Windows は未対応です）。');
    expect(load).not.toHaveBeenCalled();
  });

  it('draws the engine, the models and the three paths, describing what an empty path stands for', async () => {
    const { container, host } = mount(true);
    expect(names(container)).toEqual(['AI のエンジン', 'claude のモデル', 'codex のモデル', 'claude の場所', 'codex の場所', 'yt-dlp の場所']);
    await flush();
    expect(container.textContent).toContain('空欄なら /opt/homebrew/bin/claude を使います。');
    expect(container.textContent).toContain('https://github.com/yt-dlp/yt-dlp#installation');
    // Describing is checking files only: nothing was started.
    expect(host.children).toEqual([]);
  });

  it('says when an npm install is found but the node it needs is not', async () => {
    const host = new FakeHost({ executables: ['/opt/homebrew/bin/claude'], links: { '/opt/homebrew/bin/claude': '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js' } });
    const { container } = mount(true, host);
    await flush();
    await flush();
    expect(container.textContent).toContain('/opt/homebrew/bin/claude にありますが、動かすのに要る Node.js が見つかりません。');
  });

  it('saves the engine and a model to data.json and a path to this device', async () => {
    const { container, prefs, paths, prefsSave } = mount(true);
    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = 'codex';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const [claudeModel, , , , ytdlp] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]'));
    if (!claudeModel || !ytdlp) throw new Error('fields');
    claudeModel.value = ' opus ';
    claudeModel.dispatchEvent(new Event('input', { bubbles: true }));
    ytdlp.value = '/x/yt-dlp';
    ytdlp.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(prefsSave).toHaveBeenCalledTimes(2);
    expect(prefs()).toEqual({ engine: 'codex', claudeModel: 'opus', codexModel: '' });
    expect(paths()).toEqual({ claude: '', codex: '', 'yt-dlp': '/x/yt-dlp' });
    expect(container.textContent).toContain('このパスにプログラムがありません。');
  });

  it('runs the login shell only when 「探す」 is pressed, and fills the field', async () => {
    const host = new FakeHost({
      env: { SHELL: '/bin/zsh' }, executables: ['/Users/user/bin/codex'],
      onSpawn: child => { queueMicrotask(() => { child.out('/Users/user/bin/codex\n'); child.close(0); }); },
    });
    const { container, paths } = mount(true, host);
    await flush();
    expect(host.children).toEqual([]);
    const buttons = Array.from(container.querySelectorAll('button')).filter(button => button.textContent === '探す');
    expect(buttons).toHaveLength(3);
    buttons[1]?.click();
    for (let i = 0; i < 20 && paths().codex === ''; i++) await flush();
    expect(host.children.map(child => child.args)).toEqual([['-ilc', 'command -v codex']]);
    expect(paths().codex).toBe('/Users/user/bin/codex');
    expect(Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]'))[3]?.value).toBe('/Users/user/bin/codex');
  });
});
