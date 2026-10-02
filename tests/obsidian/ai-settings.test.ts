// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import type { PluginSettingTab as HarnessSettingTab } from '../browser-harness/obsidian';
import { LicenseRequestError } from '../../src/ai/license/client';
import type { Entitlement, EntitlementState } from '../../src/ai/license/entitlement';
import { licenseStatusText, reasonText } from '../../src/obsidian/ai-settings';
import { DEFAULT_SETTINGS } from '../../src/obsidian/settings';
import { MappySettingTab } from '../../src/obsidian/settings-tab';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

/** An entitlement the test moves by hand; `register` answers with what `answer` says. */
function fakeEntitlement(initial: EntitlementState) {
  let state = initial;
  const listeners = new Set<(next: EntitlementState) => void>();
  let answer: () => Promise<EntitlementState> = () => Promise.resolve(state);
  const entitlement = {
    load: vi.fn(() => Promise.resolve(state)),
    state: () => state,
    onChange: (listener: (next: EntitlementState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    register: vi.fn<(code: string) => Promise<EntitlementState>>(() => answer()),
    refresh: vi.fn(() => Promise.resolve(state)),
    dispose: vi.fn(),
  } satisfies Entitlement;
  return {
    entitlement,
    listeners,
    move: (next: EntitlementState): void => { state = next; for (const listener of [...listeners]) listener(next); },
    answer: (next: () => Promise<EntitlementState>): void => { answer = next; },
  };
}

function mount(initial: EntitlementState = { kind: 'unregistered' }) {
  const fake = fakeEntitlement(initial);
  const tab = new MappySettingTab({} as App, {} as Plugin, { current: () => DEFAULT_SETTINGS, save: vi.fn() }, fake.entitlement);
  document.body.append(tab.containerEl);
  tab.display();
  return { ...fake, tab, ...row(tab.containerEl) };
}

function row(container: HTMLElement) {
  const items = Array.from(container.querySelectorAll<HTMLElement>('.setting-item'));
  const heading = items.find(item => item.querySelector('.setting-item-name')?.textContent === 'AI 機能');
  const license = items.find(item => item.querySelector('.setting-item-name')?.textContent === 'ライセンスコード');
  const input = license?.querySelector<HTMLInputElement>('input[type="text"]');
  const button = license?.querySelector<HTMLButtonElement>('button');
  const status = license?.querySelector<HTMLElement>('.mappy-setting-ai-status');
  const failure = license?.querySelector<HTMLElement>('.mappy-setting-ai-failure');
  if (!heading || !license || !input || !button || !status || !failure) throw new Error('The AI section did not render');
  return { heading, license, input, button, status, failure };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('the settings tab\'s AI section (LEV-273, docs/architecture.md §11.6)', () => {
  it('draws a heading, then the license code field, its button and the state, without asking the entitlement anything else', () => {
    const { heading, input, button, status, entitlement } = mount();
    expect(heading.classList.contains('setting-item-heading')).toBe(true);
    expect(heading.querySelector('.setting-item-description')?.textContent).toContain('コードを登録するときと期限の切れたトークンを更新するときだけ');
    expect(input.placeholder).toBe('ライセンスコードを入力');
    expect(button.textContent).toBe('登録');
    expect(status.textContent).toBe('未登録です。');
    expect(entitlement.register).not.toHaveBeenCalled();
    expect(entitlement.refresh).not.toHaveBeenCalled();
    expect(entitlement.load).not.toHaveBeenCalled();
  });

  it.each<[EntitlementState, string]>([
    [{ kind: 'checking' }, 'ライセンスを確認しています…'],
    [{ kind: 'unregistered' }, '未登録です。'],
    [{ kind: 'active', expiresAt: Date.UTC(2026, 9, 31) }, `有効です（${new Date(Date.UTC(2026, 9, 31)).toLocaleString('ja-JP')} まで）。`],
    [{ kind: 'expired' }, '期限が切れています。次に AI を使うときに更新します。'],
    [{ kind: 'unreachable', reason: 'offline' }, 'ライセンスサーバーに接続できませんでした（offline）。次に AI を使うときにもう一度試します。'],
    [{ kind: 'invalid', reason: 'license cancelled' }, '無効です（license cancelled）。ライセンスコードを入れ直してください。'],
  ])('names the state %j', (state, text) => {
    expect(licenseStatusText(state)).toBe(text);
    expect(mount(state).status.textContent).toBe(text);
  });

  it.each<[string, string]>([
    ['net:timeout', '時間内に応答がありません'],
    ['net:error', '通信できません'],
    ['net:unexpected-response', '想定外の応答です'],
    ['net:waiting', '前の要求の応答を待っています'],
    ['net:http-503', 'HTTP 503 の応答です'],
    ['license cancelled', 'license cancelled'],
  ])('words the reason %s in the UI language, and shows the server\'s own text as it is', (reason, text) => {
    expect(reasonText(reason)).toBe(text);
  });

  it('tells a device whose token the bundled key cannot confirm to update Mappy, not to enter the code again', () => {
    expect(licenseStatusText({ kind: 'invalid', reason: 'token:bad-signature' })).toBe('この版の Mappy ではライセンスを確かめられませんでした。Mappy を最新の版に更新してください。');
    expect(licenseStatusText({ kind: 'unreachable', reason: 'net:waiting' })).toBe('ライセンスサーバーに接続できませんでした（前の要求の応答を待っています）。次に AI を使うときにもう一度試します。');
  });

  it('still says why a new code failed on a device that is already active', async () => {
    const { input, button, failure, answer } = mount({ kind: 'active', expiresAt: Date.UTC(2026, 9, 31) });
    type(input, 'MISTYPED');
    answer(() => Promise.reject(new LicenseRequestError('rejected', 'unknown code')));
    button.click();
    await flush();
    expect(failure.hidden).toBe(false);
    expect(failure.textContent).toBe('コードが受け付けられませんでした（unknown code）。');
  });

  it('clears the failure line when a registration given up on goes through after all', async () => {
    const { input, button, failure, answer, move } = mount();
    type(input, 'CODE');
    answer(() => Promise.reject(new LicenseRequestError('unreachable', 'net:timeout')));
    button.click();
    await flush();
    expect(failure.hidden).toBe(false);
    move({ kind: 'active', expiresAt: Date.UTC(2026, 9, 31) });
    expect(failure.hidden).toBe(true);
  });

  it('keeps the button off until a code is typed, and registers the trimmed field only when pressed', async () => {
    const { input, button, entitlement, answer, move, status } = mount();
    expect(button.disabled).toBe(true);
    type(input, '   ');
    expect(button.disabled).toBe(true);
    type(input, 'GOOD-CODE');
    expect(button.disabled).toBe(false);
    expect(entitlement.register).not.toHaveBeenCalled();
    answer(() => { move({ kind: 'active', expiresAt: Date.UTC(2026, 9, 31) }); return Promise.resolve({ kind: 'active', expiresAt: Date.UTC(2026, 9, 31) }); });
    button.click();
    expect(button.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    await flush();
    expect(entitlement.register).toHaveBeenCalledWith('GOOD-CODE');
    expect(status.textContent).toContain('有効です');
    expect(input.value).toBe('');
    expect(input.disabled).toBe(false);
  });

  it.each<[Error, string]>([
    [new LicenseRequestError('rejected', 'unknown code'), 'コードが受け付けられませんでした（unknown code）。'],
    [new LicenseRequestError('unreachable', 'offline'), 'ライセンスサーバーに接続できませんでした（offline）。'],
    [new Error('storage is full'), 'コードを登録できませんでした（storage is full）。'],
  ])('says why a registration failed (%s), keeping the code and the state', async (error, text) => {
    const { input, button, failure, status, answer } = mount();
    type(input, 'CODE');
    answer(() => Promise.reject(error));
    button.click();
    await flush();
    expect(failure.hidden).toBe(false);
    expect(failure.textContent).toBe(text);
    expect(status.textContent).toBe('未登録です。');
    expect(input.value).toBe('CODE');
    expect(button.disabled).toBe(false);
    // The next attempt clears the message first.
    answer(() => Promise.resolve({ kind: 'unregistered' }));
    button.click();
    expect(failure.hidden).toBe(true);
  });

  it('follows the entitlement with one subscription however often the tab is drawn, and lets go of the rows display() dropped', () => {
    const { status, move, listeners, tab } = mount({ kind: 'checking' });
    move({ kind: 'unregistered' });
    expect(status.textContent).toBe('未登録です。');
    for (let round = 0; round < 5; round += 1) tab.display();
    expect(listeners.size).toBe(1);
    move({ kind: 'expired' });
    // The first row was dropped by the next display(): it is no longer brought up to date.
    expect(status.textContent).toBe('未登録です。');
    expect(row(tab.containerEl).status.textContent).toBe('期限が切れています。次に AI を使うときに更新します。');
  });

  it('keeps a row drawn before it is in the document up to date (1.13 renders before it inserts)', () => {
    const { tab, move } = mount({ kind: 'checking' });
    const runtime = tab as unknown as HarnessSettingTab;
    tab.containerEl.remove();
    runtime.update();
    runtime.renderTab();
    const drawn = row(tab.containerEl).status;
    move({ kind: 'unregistered' });
    expect(drawn.textContent).toBe('未登録です。');
  });

  it('lets go of a row taken out of the document without its cleanup (a settings search result dropped)', () => {
    const { tab, move } = mount();
    const runtime = tab as unknown as HarnessSettingTab;
    runtime.update();
    runtime.renderTab();
    const drawn = row(tab.containerEl).status;
    tab.containerEl.remove();
    move({ kind: 'expired' });
    // Back in the document, the row was let go on the change above: it is not brought up to date any more.
    document.body.append(tab.containerEl);
    move({ kind: 'invalid', reason: 'revoked' });
    expect(drawn.textContent).toBe('未登録です。');
  });

  it('draws the same row through Obsidian 1.13+\'s declarative path, whose cleanup lets the row go', () => {
    const { tab, listeners, move } = mount();
    const runtime = tab as unknown as HarnessSettingTab;
    runtime.update();
    runtime.renderTab();
    const drawn = row(tab.containerEl).status;
    expect(drawn.textContent).toBe('未登録です。');
    move({ kind: 'expired' });
    expect(drawn.textContent).toBe('期限が切れています。次に AI を使うときに更新します。');
    runtime.hide();
    move({ kind: 'unregistered' });
    expect(drawn.textContent).toBe('期限が切れています。次に AI を使うときに更新します。');
    expect(listeners.size).toBe(1);
  });
});
