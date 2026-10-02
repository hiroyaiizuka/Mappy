import { createLicenseClient, LicenseRequestError, NETWORK_REASONS, type IssuedTokens, type LicenseClient } from './client';
import { DevUnlockEntitlement } from './dev-unlock';
import { createLicenseStore, type LicenseStore, type StoredLicense } from './store';
import { createTokenVerifier, type TokenVerifier } from './token';

/** The reason a registration failed; the client stays behind this file (tests/tooling/ai-boundaries.test.mjs). */
export { LicenseRequestError, NETWORK_REASONS };
export { TOKEN_REASONS } from './token';

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

export const LICENSE_LOCK_NAME = 'mappy-ai-license-refresh';

function webLock(): LicenseLock {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return task => task();
  // `request` resolves with what the task resolves with; its typing nests the promise.
  return <T>(task: () => Promise<T>) => locks.request(LICENSE_LOCK_NAME, task) as Promise<unknown> as Promise<T>;
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

/**
 * How long a refresh given up on holds back the next one. Its answer is still kept when it arrives later (the
 * refused path keeps the secret it was sent with), but a request that never settles must not block refreshing for good.
 */
export const LATE_WAIT_MS = 2 * 60 * 1000;

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
  /**
   * Tokens the server issued that this device could not store (storage full or blocked): used in place of the store
   * until a write succeeds, another window writes, or the plugin unloads, so a rotated secret is not lost at once.
   */
  private unsaved: StoredLicense | null = null;
  /** A request given up on after the timeout and still on its way; no other is sent with the same secret meanwhile. */
  private late: Promise<unknown> | null = null;
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
    this.unwatch = deps.store.subscribe(() => {
      this.unsaved = null;
      void this.load();
    });
  }

  private read(): StoredLicense | null {
    return this.unsaved ?? this.deps.store.read();
  }

  /** Store `next`, or keep it in memory when the store refuses (and throw, for the caller to say so). */
  private save(next: StoredLicense): void {
    try {
      this.deps.store.write(next);
      this.unsaved = null;
    } catch (error) {
      this.unsaved = next;
      throw error;
    }
  }

  /**
   * Watch a request given up on: `keep` runs under the lock with what the server answered in the end. The next
   * refresh waits for it, at most `LATE_WAIT_MS`.
   */
  private watchLate(late: Promise<IssuedTokens>, keep: (tokens: IssuedTokens) => Promise<EntitlementState>): void {
    const settled: Promise<unknown> = late.then(tokens => this.lock(() => keep(tokens)), () => undefined)
      .catch(() => undefined)
      .finally(() => { if (this.late === settled) this.late = null; });
    this.late = settled;
    this.timers.set(() => { if (this.late === settled) this.late = null; }, LATE_WAIT_MS);
  }

  /** Before its first verification ends this stays `checking`; later ones keep the previous state until they end. */
  load(): Promise<EntitlementState> {
    return this.adopt(this.read());
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
   * The device ID is stored before the request, so a retry after a lost answer is the same device. Tokens the
   * device cannot store are still used until the plugin unloads, and the failure is thrown so the settings say so.
   */
  register(code: string): Promise<EntitlementState> {
    const licenseCode = code.trim();
    if (licenseCode === '') return Promise.resolve(this.state());
    return this.lock(async () => {
      let stored = this.read();
      if (!stored) {
        stored = { deviceId: this.newDeviceId() };
        try {
          this.save(stored);
        } catch {
          // Kept in memory (`save`): the code can still be registered; the tokens follow the same way.
        }
      }
      const { deviceId } = stored;
      // What the device held when the code went out: a late answer is kept unless someone stored a newer pair since.
      const before = stored.refreshSecret;
      const registered = (tokens: IssuedTokens): StoredLicense => ({ deviceId, licenseCode, ...tokens });
      let tokens: IssuedTokens;
      try {
        tokens = await this.client.register(licenseCode, deviceId);
      } catch (error) {
        // Given up on, the registration may still go through: keep its tokens unless a newer pair was stored since
        // (a device refused earlier still holds its old secret, so "no secret yet" is not the test).
        if (error instanceof LicenseRequestError && error.late) {
          this.watchLate(error.late, late => {
            const latest = this.read();
            if (latest?.deviceId !== deviceId || latest.refreshSecret !== before) return Promise.resolve(this.state());
            return this.keepIssued(registered(late));
          });
        }
        throw error;
      }
      const next = registered(tokens);
      try {
        this.save(next);
      } catch (error) {
        await this.adopt(next, true);
        throw error;
      }
      return this.adoptIssued(next);
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
    // The secret of a request still on its way may already be rotated: sending it again would be refused.
    if (this.late) return this.settle({ kind: 'unreachable', reason: NETWORK_REASONS.waiting });
    // (1) Another window may have refreshed: use its token without sending anything.
    const first = await this.check(this.read());
    if (first.kind !== 'expired') return this.settle(first);
    return this.lock(async () => {
      // (2) Again under the lock, for a window that refreshed while this one waited.
      const stored = this.read();
      const again = await this.check(stored);
      if (again.kind !== 'expired' || !stored?.refreshSecret) return this.settle(again);
      // A window (or an instance before a plugin reload) gave up on a refresh with this secret, and its answer may
      // still rotate it on the server: sending it again would be refused, or, on a server that revokes the whole
      // chain when a used secret comes back, lose the license.
      if (stored.pending?.secret === stored.refreshSecret && this.now() < stored.pending.until) {
        return this.settle({ kind: 'unreachable', reason: NETWORK_REASONS.waiting });
      }
      const sent = stored.refreshSecret;
      let tokens: IssuedTokens;
      try {
        tokens = await this.client.refresh(stored.deviceId, sent);
      } catch (error) {
        if (error instanceof LicenseRequestError && error.kind === 'rejected') return this.refused(stored, sent, error.reason);
        // Given up on, the request may still rotate the secret on the server: keep what it answers in the end.
        if (error instanceof LicenseRequestError && error.late) {
          this.watchLate(error.late, late => this.storeLate(stored, sent, late));
          // Marked in the store too, for the other windows and a reloaded plugin (cleared by the next pair stored).
          try {
            this.save({ ...(this.read() ?? stored), pending: { secret: sent, until: this.now() + LATE_WAIT_MS } });
          } catch {
            // Kept in memory by `save`; this window still waits through `late`.
          }
        }
        return this.settle({ kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) });
      }
      return this.storeRotated(stored, tokens);
    });
  }

  /**
   * (3) The rotated token and secret, written over what is stored now. The server has just accepted `sent` and
   * rotated it, so this pair is the device's current one whatever another window stored meanwhile.
   */
  private storeRotated(stored: StoredLicense, tokens: IssuedTokens): Promise<EntitlementState> {
    return this.writeAndAdopt(stored, ({ rejected: _rejected, unverified: _unverified, pending: _pending, ...kept }) => ({ ...kept, ...tokens }));
  }

  /**
   * The answer to a refresh given up on, arriving later: kept only while `sent` is still the stored secret. Once
   * another refresh has stored a newer pair, this one is older than it.
   */
  private storeLate(stored: StoredLicense, sent: string, tokens: IssuedTokens): Promise<EntitlementState> {
    const latest = this.read() ?? stored;
    if (latest.refreshSecret !== sent) return this.adopt(latest);
    return this.storeRotated(stored, tokens);
  }

  /**
   * The server refused `sent`: the device is `invalid` (`rejected` is kept, so a reload says so too). The secret and
   * token stay stored: a refresh with the same secret given up on in another window may still bring the rotated
   * pair, which `storeLate` then keeps (and drops `rejected`). A newer secret another window stored meanwhile is kept.
   */
  private refused(stored: StoredLicense, sent: string, reason: string): Promise<EntitlementState> {
    const latest = this.read() ?? stored;
    if (latest.refreshSecret !== sent) return this.adopt(latest);
    return this.writeAndAdopt(stored, current => ({ ...current, rejected: reason }));
  }

  /** Write `change(latest)` and verify it as just issued. */
  private writeAndAdopt(stored: StoredLicense, change: (latest: StoredLicense) => StoredLicense): Promise<EntitlementState> {
    return this.keepIssued(change(this.read() ?? stored));
  }

  /**
   * Keep what the server has just issued and verify it. A store that cannot be written keeps it in memory instead:
   * the server has already retired the previous secret, so dropping the new pair would lose the license.
   */
  private keepIssued(next: StoredLicense): Promise<EntitlementState> {
    try {
      this.save(next);
    } catch {
      return this.adopt(next, true);
    }
    return this.adoptIssued(next);
  }

  /** Verify what the server has just issued; a token that does not verify is marked, so a reload keeps it `invalid`. */
  private async adoptIssued(next: StoredLicense): Promise<EntitlementState> {
    const state = await this.adopt(next, true);
    if (state.kind === 'invalid' && !next.rejected && next.accessToken) {
      try {
        this.save({ ...next, unverified: state.reason });
      } catch {
        // Not kept: a reload reads the token as one to refresh, which asks the server again.
      }
    }
    return state;
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
    if (token.kind === 'unsigned') {
      if (issued) return { kind: 'invalid', reason: token.reason };
      return stored.unverified ? { kind: 'invalid', reason: stored.unverified } : { kind: 'expired' };
    }
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
  return new LicenseEntitlement({ store: createLicenseStore(), verifier: createTokenVerifier() });
}
