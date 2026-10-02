import { createLicenseClient, LicenseRequestError, type IssuedTokens, type LicenseClient } from './client';
import { DevUnlockEntitlement } from './dev-unlock';
import { createWindowLicenseStore, type LicenseStore, type StoredLicense } from './store';
import { createTokenVerifier, type TokenVerifier } from './token';

/** The reason a registration failed; the client stays behind this file (tests/tooling/ai-boundaries.test.mjs). */
export { LicenseRequestError };

/** docs/architecture.md §11.6「受け口」. */
export type EntitlementState =
  | { kind: 'checking' }                             // 保存されたトークンを検証している間（起動直後）
  | { kind: 'unregistered' }                         // 無料状態。リフレッシュシークレットが無い
  | { kind: 'active'; expiresAt: number }            // 公開鍵で検証が通り、期限内
  | { kind: 'expired' }                              // 登録済みで期限切れ（リフレッシュできる）
  | { kind: 'unreachable'; reason: string }          // 登録済みで期限切れ、リフレッシュの通信に失敗した（再試行できる）
  | { kind: 'invalid'; reason: string };             // 検証できない・サーバーがリフレッシュを拒んだ

export interface Entitlement {
  /** Read the store and verify its token (offline). Called on load and on another window's write. */
  load(): Promise<EntitlementState>;
  /** The last verified state, with an `active` past its `expiresAt` read as `expired` at the time of the call. */
  state(): EntitlementState;
  onChange(listener: (state: EntitlementState) => void): () => void;
  /** Only when the user enters a code in the settings and presses the button. */
  register(code: string): Promise<EntitlementState>;
  /** Only when registered: the AI button calls it when the token has expired. */
  refresh(): Promise<EntitlementState>;
  /** Stop the expiry timer (plugin unload). */
  dispose(): void;
}

/** The AI button shows for a device that is registered and can get back to `active` by refreshing (§11.6). */
export function showsAiButton(state: EntitlementState): boolean {
  return state.kind === 'active' || state.kind === 'expired' || state.kind === 'unreachable';
}

/** The runner (and with it Node, §11.1) is only made for a verified, unexpired token (§11.6). */
export function allowsAiRunner(state: EntitlementState): boolean {
  return state.kind === 'active';
}

/** Runs `task` while no other window of this device refreshes: Web Locks, or nothing where the API is missing. */
export type LicenseLock = <T>(task: () => Promise<T>) => Promise<T>;

export const LICENSE_LOCK_NAME = 'mappy-ai-license';

function webLock(): LicenseLock {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return task => task();
  return async <T>(task: () => Promise<T>): Promise<T> => {
    let result!: T;
    await locks.request(LICENSE_LOCK_NAME, async () => { result = await task(); });
    return result;
  };
}

export interface EntitlementDeps {
  store: LicenseStore;
  verifier: TokenVerifier;
  client?: LicenseClient;
  now?: () => number;
  newDeviceId?: () => string;
  lock?: LicenseLock;
  timers?: LicenseTimers;
}

/** The expiry timer's clock; the window's by default. */
export interface LicenseTimers { set(run: () => void, delay: number): number; clear(id: number): void }

const windowTimers: LicenseTimers = {
  set: (run, delay) => window.setTimeout(run, delay),
  clear: id => { window.clearTimeout(id); },
};

/** setTimeout's longest delay; a later expiry re-arms on the way. */
const MAX_TIMER = 2 ** 31 - 1;

const sameState = (a: EntitlementState, b: EntitlementState): boolean => JSON.stringify(a) === JSON.stringify(b);

export class LicenseEntitlement implements Entitlement {
  private current: EntitlementState = { kind: 'checking' };
  private told: EntitlementState = { kind: 'checking' };
  /** Each change of `current` takes a ticket; a verification that finishes after a newer one is dropped. */
  private ticket = 0;
  private readonly listeners = new Set<(state: EntitlementState) => void>();
  private timer: number | null = null;
  private refreshing: Promise<EntitlementState> | null = null;
  private disposed = false;
  private readonly client: LicenseClient;
  private readonly now: () => number;
  private readonly newDeviceId: () => string;
  private readonly lock: LicenseLock;
  private readonly timers: LicenseTimers;
  private readonly unwatch: () => void;

  /** Another window's write (the store's `storage` event) is verified again, offline, keeping the state meanwhile. */
  constructor(private readonly deps: EntitlementDeps) {
    this.client = deps.client ?? createLicenseClient();
    this.now = deps.now ?? (() => Date.now());
    this.newDeviceId = deps.newDeviceId ?? (() => crypto.randomUUID());
    this.lock = deps.lock ?? webLock();
    this.timers = deps.timers ?? windowTimers;
    this.unwatch = deps.store.subscribe(() => { void this.load(); });
  }

  /** Before its first verification ends this stays `checking`; later ones keep the previous state until they end. */
  load(): Promise<EntitlementState> {
    return this.adopt(this.deps.store.read());
  }

  state(): EntitlementState {
    const { current } = this;
    return current.kind === 'active' && this.now() >= current.expiresAt ? { kind: 'expired' } : current;
  }

  onChange(listener: (state: EntitlementState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Sends the code with this device's ID. A request that fails throws its `LicenseRequestError` and leaves what was
   * stored and the state as they were (a failed first registration is still `unregistered`, not `unreachable`).
   * The device ID is stored before the request, so a retry after a lost answer is the same device.
   */
  register(code: string): Promise<EntitlementState> {
    const licenseCode = code.trim();
    if (licenseCode === '') return Promise.resolve(this.state());
    return this.lock(async () => {
      let stored = this.deps.store.read();
      if (!stored) {
        stored = { deviceId: this.newDeviceId() };
        this.deps.store.write(stored);
      }
      const tokens = await this.client.register(licenseCode, stored.deviceId);
      const next: StoredLicense = { deviceId: stored.deviceId, licenseCode, ...tokens };
      this.deps.store.write(next);
      return this.adopt(next, true);
    });
  }

  /**
   * Only from `expired` and `unreachable`; any other state is returned as it is, without a request. One at a
   * time in this window, and under the lock across windows, reading the store again before sending: another window
   * may have refreshed already, and its new secret must not be overwritten by one this window would get with the
   * old secret (§11.6「リフレッシュの排他」).
   */
  refresh(): Promise<EntitlementState> {
    this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  dispose(): void {
    this.disposed = true;
    this.unwatch();
    this.clearTimer();
    this.listeners.clear();
  }

  private async refreshOnce(): Promise<EntitlementState> {
    const before = this.state();
    if (before.kind !== 'expired' && before.kind !== 'unreachable') return before;
    // (1) Another window may have refreshed: use its token without sending anything.
    if ((await this.check(this.deps.store.read())).kind !== 'expired') return this.load();
    return this.lock(async () => {
      // (2) Again under the lock, for a window that refreshed while this one waited.
      const stored = this.deps.store.read();
      if ((await this.check(stored)).kind !== 'expired' || !stored?.refreshSecret) return this.adopt(stored);
      let tokens: IssuedTokens;
      try {
        tokens = await this.client.refresh(stored.deviceId, stored.refreshSecret);
      } catch (error) {
        if (error instanceof LicenseRequestError && error.kind === 'rejected') {
          return this.writeAndAdopt(stored, ({ deviceId, licenseCode }) => ({
            deviceId, ...(licenseCode ? { licenseCode } : {}), rejected: error.reason,
          }));
        }
        return this.settle({ kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) });
      }
      // (3) Only the token and the secret are written, over what is stored now.
      return this.writeAndAdopt(stored, latest => {
        const { rejected: _dropped, ...kept } = latest;
        return { ...kept, ...tokens };
      });
    });
  }

  /** Write `change(latest)` and verify it as just issued; a store that cannot be written leaves the device `unreachable`. */
  private writeAndAdopt(stored: StoredLicense, change: (latest: StoredLicense) => StoredLicense): Promise<EntitlementState> {
    const next = change(this.deps.store.read() ?? stored);
    try {
      this.deps.store.write(next);
    } catch (error) {
      return Promise.resolve(this.settle({ kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) }));
    }
    return this.adopt(next, true);
  }

  /** `issued`: the token was just issued by the server (register, refresh), not read back from the store. */
  private async adopt(stored: StoredLicense | null, issued = false): Promise<EntitlementState> {
    const ticket = ++this.ticket;
    const next = await this.check(stored, issued);
    if (ticket === this.ticket) this.apply(next);
    return this.state();
  }

  /**
   * What a stored license is worth now, verifying its token. A stored token that does not verify, while the device
   * still has its refresh secret, reads as `expired`: a refresh may recover it (the bundled public key replaced by a
   * plugin update, a token damaged in storage), and the server decides. A token the server has just issued that
   * does not verify is `invalid`, so a key that can never verify does not send a refresh on every press.
   */
  private async check(stored: StoredLicense | null, issued = false): Promise<EntitlementState> {
    if (stored?.rejected) return { kind: 'invalid', reason: stored.rejected };
    if (!stored?.refreshSecret) return { kind: 'unregistered' };
    if (!stored.accessToken) return { kind: 'expired' };
    const token = await this.deps.verifier.verify(stored.accessToken);
    if (token.kind === 'unsigned') return issued ? { kind: 'invalid', reason: token.reason } : { kind: 'expired' };
    return this.now() < token.expiresAt ? { kind: 'active', expiresAt: token.expiresAt } : { kind: 'expired' };
  }

  private settle(next: EntitlementState): EntitlementState {
    this.ticket += 1;
    this.apply(next);
    return this.state();
  }

  /**
   * Listeners hear a state once; `state()` may have read an expiry before the timer told them. After `dispose`, a
   * verification or request still in flight changes nothing here (its store write stands: a rotated secret must be
   * kept), so no timer outlives the plugin.
   */
  private apply(next: EntitlementState): void {
    if (this.disposed) return;
    this.current = next;
    this.clearTimer();
    if (next.kind === 'active') this.armTimer(next.expiresAt);
    const now = this.state();
    if (sameState(this.told, now)) return;
    this.told = now;
    for (const listener of [...this.listeners]) listener(now);
  }

  /** One timer at the expiry, so the AI button learns of it without polling; it sends nothing. */
  private armTimer(expiresAt: number): void {
    const delay = expiresAt - this.now();
    if (delay <= 0) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.current.kind !== 'active' || this.current.expiresAt !== expiresAt) return;
      if (this.now() < expiresAt) { this.armTimer(expiresAt); return; }
      this.apply({ kind: 'expired' });
    }, Math.min(delay, MAX_TIMER));
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/**
 * The plugin's entitlement. The development unlock exists only in a `MAPPY_AI_DEV_UNLOCK=1` build: in every other
 * build the condition is the literal `false`, and esbuild drops the branch and `DevUnlockEntitlement` with it.
 */
export function createEntitlement(): Entitlement {
  if (MAPPY_AI_DEV_UNLOCK) return new DevUnlockEntitlement();
  return new LicenseEntitlement({ store: createWindowLicenseStore(), verifier: createTokenVerifier() });
}
