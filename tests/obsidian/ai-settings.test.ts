// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import type { PluginSettingTab as HarnessSettingTab } from '../browser-harness/obsidian';
import { LicenseRequestError } from '../../src/ai/license/client';
import type { Entitlement, EntitlementState } from '../../src/ai/license/entitlement';
import { licenseStatusText } from '../../src/obsidian/ai-settings';
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
    [{ kind: 'active', expiresAt: Date.UTC(2026, 9, 31) }, `有効です（${new Date(Date.UTC(2026, 9, 31)).toLocaleString()} まで）。`],
    [{ kind: 'expired' }, '期限が切れています。次に AI を使うときに更新します。'],
    [{ kind: 'unreachable', reason: 'offline' }, 'ライセンスサーバーに接続できませんでした（offline）。次に AI を使うときにもう一度試します。'],
    [{ kind: 'invalid', reason: 'license cancelled' }, '無効です（license cancelled）。ライセンスコードを入れ直してください。'],
  ])('names the state %j', (state, text) => {
    expect(licenseStatusText(state)).toBe(text);
    expect(mount(state).status.textContent).toBe(text);
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
    [new LicenseRequestError('rejected', 'unknown code'), 'コードを登録できませんでした（unknown code）。'],
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

  it('follows the entitlement while drawn, and lets go of a row display() dropped', () => {
    const { status, move, listeners, tab } = mount({ kind: 'checking' });
    move({ kind: 'unregistered' });
    expect(status.textContent).toBe('未登録です。');
    expect(listeners.size).toBe(1);
    tab.display();
    expect(listeners.size).toBe(2);
    move({ kind: 'expired' });
    // The first row was out of the document, so it unsubscribed instead of updating.
    expect(listeners.size).toBe(1);
    expect(status.textContent).toBe('未登録です。');
    expect(row(tab.containerEl).status.textContent).toBe('期限が切れています。次に AI を使うときに更新します。');
  });

  it('draws the same row through Obsidian 1.13+\'s declarative path, whose cleanup unsubscribes', () => {
    const { tab, listeners } = mount();
    const runtime = tab as unknown as HarnessSettingTab;
    runtime.update();
    runtime.renderTab();
    expect(row(tab.containerEl).status.textContent).toBe('未登録です。');
    // display()'s row unsubscribes on the next change; the declarative row has its own subscription.
    expect(listeners.size).toBe(2);
    runtime.hide();
    expect(listeners.size).toBe(1);
  });
});
