import { describe, expect, it, vi } from 'vitest';
import { LicenseRequestError, type IssuedTokens, type LicenseClient } from '../../../src/ai/license/client';
import { DevUnlockEntitlement } from '../../../src/ai/license/dev-unlock';
import {
  allowsAiRunner, LATE_WAIT_MS, LicenseEntitlement, showsAiButton, type EntitlementDeps, type EntitlementState, type LicenseTimers,
} from '../../../src/ai/license/entitlement';
import { createTokenVerifier } from '../../../src/ai/license/token';
import { SharedLicenseStorage, settle, sharedLock, signingKey, type SigningKey } from './fixtures';

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 2, 0, 0, 0);

/**
 * The license server of the provisional contract: a code registers a device, each refresh rotates the device's
 * secret, and a secret that is no longer the device's current one is refused, as the TaskChute scheme does
 * (mappy-memory designs/ai-license-activation).
 */
class FakeServer implements LicenseClient {
  readonly calls: { kind: 'register' | 'refresh'; body: Record<string, string> }[] = [];
  private readonly secrets = new Map<string, string>();
  private issued = 0;
  /** What the next requests do instead of answering. */
  failure: LicenseRequestError | null = null;
  /** Holds every answer until released, so a test can act while a request is in flight. */
  gate: Promise<void> | null = null;
  lifetime = HOUR;
  constructor(private readonly key: SigningKey, private readonly clock: () => number, readonly codes = new Set(['GOOD-CODE'])) {}

  async register(licenseCode: string, deviceId: string): Promise<IssuedTokens> {
    this.calls.push({ kind: 'register', body: { licenseCode, deviceId } });
    await this.gate;
    if (this.failure) throw this.failure;
    if (!this.codes.has(licenseCode)) throw new LicenseRequestError('rejected', 'unknown code');
    return this.issue(deviceId);
  }

  async refresh(deviceId: string, refreshSecret: string): Promise<IssuedTokens> {
    this.calls.push({ kind: 'refresh', body: { deviceId, refreshSecret } });
    await this.gate;
    if (this.failure) throw this.failure;
    if (this.secrets.get(deviceId) !== refreshSecret) throw new LicenseRequestError('rejected', 'refresh secret revoked');
    return this.issue(deviceId);
  }

  private async issue(deviceId: string): Promise<IssuedTokens> {
    this.issued += 1;
    const refreshSecret = `secret-${this.issued}`;
    this.secrets.set(deviceId, refreshSecret);
    const accessToken = await this.key.sign({ sub: deviceId, exp: Math.floor((this.clock() + this.lifetime) / 1000) });
    return { accessToken, refreshSecret };
  }
}

/** Timers on the test's clock: `advance` moves it and runs what fell due. */
function testClock() {
  let now = START;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: LicenseTimers = {
    set: (run, delay) => { const id = next++; pending.set(id, { at: now + delay, run }); return id; },
    clear: id => { pending.delete(id); },
  };
  return {
    now: () => now,
    timers,
    pending: () => pending.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) { pending.delete(id); timer.run(); }
      }
    },
  };
}

async function setup(options: { lock?: EntitlementDeps['lock'] } = {}) {
  const key = await signingKey();
  const clock = testClock();
  const server = new FakeServer(key, clock.now);
  const storage = new SharedLicenseStorage();
  let devices = 0;
  const open = (overrides: Partial<EntitlementDeps> = {}) => new LicenseEntitlement({
    store: storage.window(),
    verifier: createTokenVerifier(key.publicKey),
    client: server,
    now: clock.now,
    newDeviceId: () => `device-${++devices}`,
    timers: clock.timers,
    ...(options.lock ? { lock: options.lock } : {}),
    ...overrides,
  });
  return { key, clock, server, storage, open };
}

/** A registered device whose token expires in an hour. */
async function registered() {
  const env = await setup();
  const first = env.open();
  await first.load();
  await first.register('GOOD-CODE');
  first.dispose();
  env.server.calls.length = 0;
  return env;
}

describe('the AI gates by state (§11.6)', () => {
  const states: EntitlementState[] = [
    { kind: 'checking' }, { kind: 'unregistered' }, { kind: 'active', expiresAt: 1 }, { kind: 'expired' },
    { kind: 'unreachable', reason: 'offline' }, { kind: 'invalid', reason: 'revoked' },
  ];
  it('shows the AI button for active, expired and unreachable only', () => {
    expect(states.filter(showsAiButton).map(state => state.kind)).toEqual(['active', 'expired', 'unreachable']);
  });
  it('makes the runner for active only', () => {
    expect(states.filter(allowsAiRunner).map(state => state.kind)).toEqual(['active']);
  });
});

describe('LicenseEntitlement.load', () => {
  it('is checking until the first verification ends, then unregistered with nothing stored, and sends nothing', async () => {
    const { open, server } = await setup();
    const entitlement = open();
    expect(entitlement.state()).toEqual({ kind: 'checking' });
    await entitlement.load();
    expect(entitlement.state()).toEqual({ kind: 'unregistered' });
    expect(server.calls).toEqual([]);
  });

  it('reads a stored device without a refresh secret as unregistered', async () => {
    const { open, storage } = await setup();
    storage.value = { deviceId: 'device-x' };
    const entitlement = open();
    expect(await entitlement.load()).toEqual({ kind: 'unregistered' });
  });

  it('verifies a stored token offline: active until its expiry', async () => {
    const { open, server, clock } = await registered();
    const entitlement = open();
    expect(await entitlement.load()).toEqual({ kind: 'active', expiresAt: START + HOUR });
    expect(server.calls).toEqual([]);
    expect(clock.pending()).toBe(1);
  });

  it('reads a signed but expired token as expired, without refreshing', async () => {
    const { open, server, clock } = await registered();
    clock.advance(2 * HOUR);
    expect(await open().load()).toEqual({ kind: 'expired' });
    expect(server.calls).toEqual([]);
  });

  it('never reads a stored token signed by another key, or tampered with, as active: it is to be refreshed', async () => {
    const { open, storage, server } = await registered();
    const other = await signingKey();
    const stored = storage.value!;
    storage.value = { ...stored, accessToken: await other.sign({ exp: Math.floor(START / 1000) + 3600 }) };
    expect(await open().load()).toEqual({ kind: 'expired' });
    const [header, , signature] = stored.accessToken!.split('.');
    const longer = btoa(JSON.stringify({ exp: Math.floor(START / 1000) + 99 * 3600 })).replace(/=+$/u, '');
    storage.value = { ...stored, accessToken: `${header}.${longer}.${signature}` };
    expect(await open().load()).toEqual({ kind: 'expired' });
    // The bundled key replaced by an update, say: the refresh secret still works, so the AI button gets the device back.
    const entitlement = open();
    await entitlement.load();
    expect((await entitlement.refresh()).kind).toBe('active');
    expect(server.calls).toHaveLength(1);
  });

  it.each(['', 'not-a-token', 'a.b', 'a.b.c'])('reads the malformed stored token %j as one to refresh, never active', async token => {
    const { open, storage } = await registered();
    storage.value = { ...storage.value!, accessToken: token };
    expect(await open().load()).toEqual({ kind: 'expired' });
  });

  it('never accepts a token whose header names another algorithm, even when signed', async () => {
    const { open, storage, key } = await registered();
    storage.value = { ...storage.value!, accessToken: await key.sign({ exp: Math.floor(START / 1000) + 3600 }, { alg: 'none' }) };
    expect(await open().load()).toEqual({ kind: 'expired' });
  });

  it('is invalid when the token the server has just issued does not verify, and stays so after a reload, so it does not refresh on every press', async () => {
    const env = await setup();
    const other = await signingKey();
    const entitlement = env.open({ verifier: createTokenVerifier(other.publicKey) });
    await entitlement.load();
    expect(await entitlement.register('GOOD-CODE')).toEqual({ kind: 'invalid', reason: 'token:bad-signature' });
    env.server.calls.length = 0;
    await entitlement.refresh();
    const reloaded = env.open({ verifier: createTokenVerifier(other.publicKey) });
    expect(await reloaded.load()).toEqual({ kind: 'invalid', reason: 'token:bad-signature' });
    await reloaded.refresh();
    expect(env.server.calls).toEqual([]);
    // An update whose bundled key verifies the token clears the mark by verifying.
    expect((await env.open().load()).kind).toBe('active');
  });

  it('uses tokens it could not store until unload, and says the store failed', async () => {
    const { open, storage, server } = await setup();
    // The device ID was stored earlier; now the storage is full.
    storage.value = { deviceId: 'device-x' };
    const entitlement = open({ store: storage.window({ failWrites: true }) });
    await entitlement.load();
    await expect(entitlement.register('GOOD-CODE')).rejects.toThrow('storage is full');
    expect(server.calls).toHaveLength(1);
    expect(entitlement.state().kind).toBe('active');
  });

  it('keeps the previous state while verifying again after another window wrote, and moves to its result', async () => {
    const { open, clock } = await registered();
    clock.advance(2 * HOUR);
    const mine = open();
    await mine.load();
    expect(mine.state()).toEqual({ kind: 'expired' });
    const seen: EntitlementState['kind'][] = [];
    mine.onChange(state => { seen.push(state.kind); });
    const other = open();
    await other.load();
    await other.refresh();
    await settle();
    // The other window's write reached this one as a storage event, verified without passing through checking.
    expect(mine.state()).toEqual({ kind: 'active', expiresAt: START + 3 * HOUR });
    expect(seen).toEqual(['active']);
  });

  it('drops a verification that ends after a newer one', async () => {
    const { open, storage, key } = await registered();
    // An older load whose verification is slow, then a newer one that clears the license.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const verifier = createTokenVerifier(key.publicKey);
    const slow = open({ verifier: { verify: async token => { await held; return verifier.verify(token); } } });
    const older = slow.load();
    storage.value = null;
    const newer = slow.load();
    await newer;
    release();
    await older;
    expect(slow.state()).toEqual({ kind: 'unregistered' });
  });
});

describe('LicenseEntitlement.state and the expiry', () => {
  it('reads an active token past its expiry as expired at the time of the call, and the timer tells the listeners', async () => {
    const { open, clock } = await registered();
    const entitlement = open();
    await entitlement.load();
    const seen: EntitlementState[] = [];
    entitlement.onChange(state => { seen.push(state); });
    clock.advance(HOUR - 1);
    expect(entitlement.state().kind).toBe('active');
    clock.advance(1);
    expect(entitlement.state()).toEqual({ kind: 'expired' });
    expect(seen).toEqual([{ kind: 'expired' }]);
    expect(clock.pending()).toBe(0);
  });

  it('reads expired even when the timer has not run (a sleeping machine)', async () => {
    const { open, clock } = await registered();
    const entitlement = open({ timers: { set: () => 0, clear: () => undefined } });
    await entitlement.load();
    clock.advance(2 * HOUR);
    expect(entitlement.state()).toEqual({ kind: 'expired' });
  });

  it('changes nothing and arms no timer when a verification still running ends after dispose', async () => {
    const { open, clock, storage, key } = await registered();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const verifier = createTokenVerifier(key.publicKey);
    const entitlement = open({ store: storage.window(), verifier: { verify: async token => { await held; return verifier.verify(token); } } });
    const heard = vi.fn();
    entitlement.onChange(heard);
    const loading = entitlement.load();
    entitlement.dispose();
    release();
    await loading;
    expect(entitlement.state()).toEqual({ kind: 'checking' });
    expect(clock.pending()).toBe(0);
    expect(heard).not.toHaveBeenCalled();
  });

  it('stops the timer and the storage subscription on dispose', async () => {
    const { open, clock, storage } = await registered();
    const store = storage.window();
    const entitlement = open({ store });
    await entitlement.load();
    expect(clock.pending()).toBe(1);
    expect(store.listeners.size).toBe(1);
    entitlement.dispose();
    expect(clock.pending()).toBe(0);
    expect(store.listeners.size).toBe(0);
  });
});

describe('LicenseEntitlement.register', () => {
  it('sends the code and a new device ID only, stores the tokens, and becomes active', async () => {
    const { open, server, storage } = await setup();
    const entitlement = open();
    await entitlement.load();
    expect(await entitlement.register('  GOOD-CODE ')).toEqual({ kind: 'active', expiresAt: START + HOUR });
    expect(server.calls).toEqual([{ kind: 'register', body: { licenseCode: 'GOOD-CODE', deviceId: 'device-1' } }]);
    expect(storage.value).toEqual({
      deviceId: 'device-1', licenseCode: 'GOOD-CODE', accessToken: expect.any(String) as string, refreshSecret: 'secret-1',
    });
  });

  it('keeps the device ID across registrations, and stores it before the request', async () => {
    const { open, server, storage } = await setup();
    const entitlement = open();
    await entitlement.load();
    server.failure = new LicenseRequestError('unreachable', 'offline');
    await expect(entitlement.register('GOOD-CODE')).rejects.toMatchObject({ kind: 'unreachable', reason: 'offline' });
    expect(storage.value).toEqual({ deviceId: 'device-1' });
    server.failure = null;
    await entitlement.register('GOOD-CODE');
    await entitlement.register('GOOD-CODE');
    expect(server.calls.map(call => call.body.deviceId)).toEqual(['device-1', 'device-1', 'device-1']);
  });

  it('leaves the state as it was when the request fails: unregistered is not unreachable', async () => {
    const { open, server } = await setup();
    const entitlement = open();
    await entitlement.load();
    server.failure = new LicenseRequestError('unreachable', 'offline');
    await expect(entitlement.register('GOOD-CODE')).rejects.toBeInstanceOf(LicenseRequestError);
    expect(entitlement.state()).toEqual({ kind: 'unregistered' });
    server.failure = null;
    await expect(entitlement.register('WRONG')).rejects.toMatchObject({ kind: 'rejected', reason: 'unknown code' });
    expect(entitlement.state()).toEqual({ kind: 'unregistered' });
  });

  it('keeps the tokens of a registration given up on that went through after all', async () => {
    const { open, server, storage } = await setup();
    let release!: () => void;
    server.gate = new Promise<void>(resolve => { release = resolve; });
    const sent: { answer?: Promise<IssuedTokens> } = {};
    const slow: LicenseClient = {
      register: (code, deviceId) => {
        sent.answer = server.register(code, deviceId);
        return Promise.reject(new LicenseRequestError('unreachable', 'timeout', sent.answer));
      },
      refresh: () => Promise.reject(new Error('unused')),
    };
    const entitlement = open({ client: slow });
    await entitlement.load();
    await expect(entitlement.register('GOOD-CODE')).rejects.toMatchObject({ reason: 'timeout' });
    expect(entitlement.state()).toEqual({ kind: 'unregistered' });
    release();
    await sent.answer;
    await settle();
    expect(storage.value).toMatchObject({ deviceId: 'device-1', licenseCode: 'GOOD-CODE', refreshSecret: 'secret-1' });
    expect(entitlement.state().kind).toBe('active');
  });

  it('keeps a late registration on a device refused earlier, which still holds its old secret', async () => {
    const { open, server, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    const entitlement = open();
    await entitlement.load();
    server.failure = new LicenseRequestError('rejected', 'license cancelled');
    await entitlement.refresh();
    expect(entitlement.state().kind).toBe('invalid');
    server.failure = null;
    // The person enters the code again; the request times out, and the server registers the device all the same.
    let release!: () => void;
    server.gate = new Promise<void>(resolve => { release = resolve; });
    const sent: { answer?: Promise<IssuedTokens> } = {};
    const slow: LicenseClient = {
      register: (code, deviceId) => {
        sent.answer = server.register(code, deviceId);
        return Promise.reject(new LicenseRequestError('unreachable', 'net:timeout', sent.answer));
      },
      refresh: () => Promise.reject(new Error('unused')),
    };
    const again = open({ client: slow });
    await again.load();
    await expect(again.register('GOOD-CODE')).rejects.toMatchObject({ reason: 'net:timeout' });
    release();
    await sent.answer;
    await settle();
    expect(storage.value).toMatchObject({ refreshSecret: 'secret-2' });
    expect(storage.value?.rejected).toBeUndefined();
    expect(again.state().kind).toBe('active');
  });

  it('sends nothing for an empty code', async () => {
    const { open, server } = await setup();
    const entitlement = open();
    await entitlement.load();
    await entitlement.register('   ');
    expect(server.calls).toEqual([]);
  });

  it('clears an earlier refusal when a code registers again', async () => {
    const { open, server, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    const entitlement = open();
    await entitlement.load();
    server.failure = new LicenseRequestError('rejected', 'license cancelled');
    await entitlement.refresh();
    expect(entitlement.state()).toEqual({ kind: 'invalid', reason: 'license cancelled' });
    server.failure = null;
    expect((await entitlement.register('GOOD-CODE')).kind).toBe('active');
    expect(storage.value?.rejected).toBeUndefined();
  });
});

describe('LicenseEntitlement.refresh', () => {
  it.each([
    ['unregistered', async (env: Awaited<ReturnType<typeof setup>>) => { const e = env.open(); await e.load(); return e; }],
    ['active', async (env: Awaited<ReturnType<typeof setup>>) => {
      const e = env.open(); await e.load(); await e.register('GOOD-CODE'); env.server.calls.length = 0; return e;
    }],
    ['checking', (env: Awaited<ReturnType<typeof setup>>) => Promise.resolve(env.open())],
  ])('sends nothing from %s', async (kind, make) => {
    const env = await setup();
    const entitlement = await make(env);
    expect(entitlement.state().kind).toBe(kind);
    expect((await entitlement.refresh()).kind).toBe(kind);
    expect(env.server.calls).toEqual([]);
  });

  it('refreshes an expired token with the device ID and the refresh secret only, and stores the rotated pair', async () => {
    const { open, server, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    const entitlement = open();
    await entitlement.load();
    expect(await entitlement.refresh()).toEqual({ kind: 'active', expiresAt: START + 3 * HOUR });
    expect(server.calls).toEqual([{ kind: 'refresh', body: { deviceId: 'device-1', refreshSecret: 'secret-1' } }]);
    expect(storage.value).toMatchObject({ deviceId: 'device-1', licenseCode: 'GOOD-CODE', refreshSecret: 'secret-2' });
  });

  it('is unreachable when the request fails, and tries again on the next call', async () => {
    const { open, server, clock } = await registered();
    clock.advance(2 * HOUR);
    const entitlement = open();
    await entitlement.load();
    server.failure = new LicenseRequestError('unreachable', 'offline');
    expect(await entitlement.refresh()).toEqual({ kind: 'unreachable', reason: 'offline' });
    server.failure = null;
    expect((await entitlement.refresh()).kind).toBe('active');
    expect(server.calls.map(call => call.kind)).toEqual(['refresh', 'refresh']);
  });

  it('is invalid when the server refuses, keeps the refusal, and stays invalid after a reload', async () => {
    const { open, server, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    const entitlement = open();
    await entitlement.load();
    server.failure = new LicenseRequestError('rejected', 'license cancelled');
    expect(await entitlement.refresh()).toEqual({ kind: 'invalid', reason: 'license cancelled' });
    expect(storage.value).toMatchObject({ deviceId: 'device-1', licenseCode: 'GOOD-CODE', refreshSecret: 'secret-1', rejected: 'license cancelled' });
    expect(await open().load()).toEqual({ kind: 'invalid', reason: 'license cancelled' });
    server.calls.length = 0;
    await entitlement.refresh();
    expect(server.calls).toEqual([]);
  });

  it('keeps the pair a refresh given up on in one window brings, after another window was refused with the same secret', async () => {
    const { open, server, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    let release!: () => void;
    server.gate = new Promise<void>(resolve => { release = resolve; });
    const sent: { answer?: Promise<IssuedTokens> } = {};
    const slow: LicenseClient = {
      register: () => Promise.reject(new Error('unused')),
      refresh: (deviceId, secret) => {
        sent.answer = server.refresh(deviceId, secret);
        return Promise.reject(new LicenseRequestError('unreachable', 'timeout', sent.answer));
      },
    };
    const a = open({ client: slow });
    await a.load();
    await a.refresh();
    // Window B sends the same secret while A's request is still on its way; the server rotates it for A first and
    // refuses B's.
    const b = open();
    await b.load();
    const refused = b.refresh();
    release();
    await sent.answer;
    await refused;
    await settle();
    expect(storage.value).toMatchObject({ refreshSecret: 'secret-2' });
    expect(storage.value?.rejected).toBeUndefined();
    expect(a.state().kind).toBe('active');
  });

  it('holds back another window, or a reloaded plugin, from sending a secret whose refresh is still on its way', async () => {
    const { open, clock, server, storage } = await registered();
    clock.advance(2 * HOUR);
    const hanging: LicenseClient = {
      register: () => Promise.reject(new Error('unused')),
      refresh: () => Promise.reject(new LicenseRequestError('unreachable', 'net:timeout', new Promise<IssuedTokens>(() => undefined))),
    };
    const first = open({ client: hanging });
    await first.load();
    await first.refresh();
    expect(storage.value?.pending).toMatchObject({ secret: 'secret-1' });
    // Another window, or the same plugin loaded again: it knows nothing of the first one's request but the store's mark.
    const other = open();
    await other.load();
    expect(await other.refresh()).toEqual({ kind: 'unreachable', reason: 'net:waiting' });
    expect(server.calls).toEqual([]);
    clock.advance(LATE_WAIT_MS);
    expect((await other.refresh()).kind).toBe('active');
    expect(storage.value?.pending).toBeUndefined();
  });

  it('stops holding back refreshes once a request given up on has not answered for LATE_WAIT_MS', async () => {
    const { open, clock, server } = await registered();
    clock.advance(2 * HOUR);
    const hanging: LicenseClient = {
      register: () => Promise.reject(new Error('unused')),
      refresh: () => Promise.reject(new LicenseRequestError('unreachable', 'timeout', new Promise<IssuedTokens>(() => undefined))),
    };
    const entitlement = open({ client: hanging });
    await entitlement.load();
    await entitlement.refresh();
    expect(await entitlement.refresh()).toEqual({ kind: 'unreachable', reason: 'net:waiting' });
    clock.advance(LATE_WAIT_MS);
    // The window that waited sends again after the wait (and is answered as the server answers it).
    expect(await entitlement.refresh()).toEqual({ kind: 'unreachable', reason: 'timeout' });
    expect(server.calls).toEqual([]);
  });

  it('registers a code when the device ID cannot be stored first', async () => {
    const { open, storage } = await setup();
    const entitlement = open({ store: storage.window({ failWrites: true }) });
    await entitlement.load();
    await expect(entitlement.register('GOOD-CODE')).rejects.toThrow('storage is full');
    expect(entitlement.state().kind).toBe('active');
  });

  it('keeps a rotated pair it cannot store in memory, and refreshes with it next time instead of the retired secret', async () => {
    const { open, clock, storage, server } = await registered();
    clock.advance(2 * HOUR);
    const entitlement = open({ store: storage.window({ failWrites: true }) });
    await entitlement.load();
    expect((await entitlement.refresh()).kind).toBe('active');
    expect(storage.value?.refreshSecret).toBe('secret-1');
    clock.advance(2 * HOUR);
    expect((await entitlement.refresh()).kind).toBe('active');
    expect(server.calls.map(call => call.body.refreshSecret)).toEqual(['secret-1', 'secret-2']);
  });

  it('sends no second refresh while one given up on is still on its way, and keeps its answer', async () => {
    const { open, server, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    let release!: () => void;
    server.gate = new Promise<void>(resolve => { release = resolve; });
    const sent: { answer?: Promise<IssuedTokens> } = {};
    const slow: LicenseClient = {
      register: () => Promise.reject(new Error('unused')),
      refresh: (deviceId, secret) => {
        sent.answer = server.refresh(deviceId, secret);
        return Promise.reject(new LicenseRequestError('unreachable', 'timeout', sent.answer));
      },
    };
    const entitlement = open({ client: slow });
    await entitlement.load();
    await entitlement.refresh();
    // The user presses AI again before the first answer arrives: nothing is sent with the same secret.
    expect(await entitlement.refresh()).toEqual({ kind: 'unreachable', reason: 'net:waiting' });
    expect(server.calls).toHaveLength(1);
    release();
    await sent.answer;
    await settle();
    expect(storage.value?.refreshSecret).toBe('secret-2');
    expect(entitlement.state().kind).toBe('active');
  });

  it('keeps a secret the server rotated after the request was given up on, so the next refresh is not refused', async () => {
    const { open, server, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    let release!: () => void;
    server.gate = new Promise<void>(resolve => { release = resolve; });
    const sent: { answer?: Promise<IssuedTokens> } = {};
    const slow: LicenseClient = {
      register: () => Promise.reject(new Error('unused')),
      refresh: (deviceId, secret) => {
        sent.answer = server.refresh(deviceId, secret);
        return Promise.reject(new LicenseRequestError('unreachable', 'timeout', sent.answer));
      },
    };
    const entitlement = open({ client: slow });
    await entitlement.load();
    expect(await entitlement.refresh()).toEqual({ kind: 'unreachable', reason: 'timeout' });
    release();
    await sent.answer;
    await settle();
    expect(storage.value?.refreshSecret).toBe('secret-2');
    expect(entitlement.state().kind).toBe('active');
  });

  it('keeps a newer secret another window stored while the old one was refused (no shared lock)', async () => {
    const { open, clock, storage } = await registered();
    clock.advance(2 * HOUR);
    const meanwhile: LicenseClient = {
      register: () => Promise.reject(new Error('unused')),
      refresh: () => {
        // Another vault window refreshed first and stored its new secret; this request carries the old one.
        storage.value = { ...storage.value!, refreshSecret: 'secret-from-the-other-window' };
        return Promise.reject(new LicenseRequestError('rejected', 'refresh secret revoked'));
      },
    };
    const entitlement = open({ client: meanwhile, lock: task => task() });
    await entitlement.load();
    expect((await entitlement.refresh()).kind).not.toBe('invalid');
    expect(storage.value).toMatchObject({ refreshSecret: 'secret-from-the-other-window' });
    expect(storage.value?.rejected).toBeUndefined();
  });

  it('sends one request for calls made while one is in flight', async () => {
    const { open, server, clock } = await registered();
    clock.advance(2 * HOUR);
    const entitlement = open();
    await entitlement.load();
    const [a, b] = await Promise.all([entitlement.refresh(), entitlement.refresh()]);
    expect(a).toEqual(b);
    expect(server.calls).toHaveLength(1);
  });

  it('uses a token another window stored instead of sending', async () => {
    const { open, server, clock } = await registered();
    clock.advance(2 * HOUR);
    const other = open();
    await other.load();
    await other.refresh();
    server.calls.length = 0;
    const late = open();
    await late.load();
    expect(late.state().kind).toBe('active');
    expect(await late.refresh()).toEqual(late.state());
    expect(server.calls).toEqual([]);
  });
});

describe('two windows of one device refreshing at once (§11.6「リフレッシュの排他」)', () => {
  async function race(lock: EntitlementDeps['lock'] | undefined) {
    const env = await setup(lock ? { lock } : {});
    const first = env.open();
    await first.load();
    await first.register('GOOD-CODE');
    first.dispose();
    env.server.calls.length = 0;
    env.clock.advance(2 * HOUR);
    const a = env.open();
    const b = env.open();
    await Promise.all([a.load(), b.load()]);
    const results = await Promise.all([a.refresh(), b.refresh()]);
    await settle();
    return { env, a, b, results };
  }

  it('sends one refresh, and both windows end active on the one stored secret', async () => {
    const { env, a, b } = await race(sharedLock());
    expect(env.server.calls).toEqual([{ kind: 'refresh', body: { deviceId: 'device-1', refreshSecret: 'secret-1' } }]);
    expect(a.state().kind).toBe('active');
    expect(b.state().kind).toBe('active');
    expect(env.storage.value?.refreshSecret).toBe('secret-2');
  });

  it('without the lock, both send the same secret and one window is refused (why the lock is there)', async () => {
    const noLock = <T>(task: () => Promise<T>): Promise<T> => task();
    const { env, results } = await race(noLock);
    expect(env.server.calls.map(call => call.body.refreshSecret)).toEqual(['secret-1', 'secret-1']);
    expect(results.map(state => state.kind).sort()).toEqual(['active', 'invalid']);
  });
});

describe('DevUnlockEntitlement', () => {
  it('is active with no store and no network', async () => {
    const dev = new DevUnlockEntitlement();
    expect(dev.state().kind).toBe('active');
    expect(allowsAiRunner(await dev.load())).toBe(true);
    expect((await dev.register()).kind).toBe('active');
    expect((await dev.refresh()).kind).toBe('active');
    expect(dev.marker).toBe('mappy-ai-dev-unlock');
  });
});

describe('the token check without WebCrypto', () => {
  it('reads a token as unsigned, never throws, when crypto.subtle is missing', async () => {
    const key = await signingKey();
    const token = await key.sign({ exp: Math.floor(START / 1000) + 3600 });
    vi.stubGlobal('crypto', {});
    try {
      await expect(createTokenVerifier(key.publicKey).verify(token)).resolves.toEqual({ kind: 'unsigned', reason: 'token:no-key' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the default lock', () => {
  it('runs the task without Web Locks where navigator.locks is missing', async () => {
    vi.stubGlobal('navigator', {});
    try {
      const { key } = await setup();
      const storage = new SharedLicenseStorage();
      const entitlement = new LicenseEntitlement({ store: storage.window(), verifier: createTokenVerifier(key.publicKey), client: {
        register: () => Promise.reject(new LicenseRequestError('unreachable', 'offline')),
        refresh: () => Promise.reject(new Error('unused')),
      }, timers: { set: () => 0, clear: () => undefined } });
      await expect(entitlement.register('CODE')).rejects.toMatchObject({ reason: 'offline' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
