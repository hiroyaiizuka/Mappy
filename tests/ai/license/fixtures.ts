// A license server's side, as the provisional contract has it (src/ai/license/token.ts, client.ts): an ES256 key
// pair that signs tokens, and an in-memory store and lock to drive LicenseEntitlement with.
import type { LicenseStore, StoredLicense } from '../../../src/ai/license/store';
import type { LicenseLock } from '../../../src/ai/license/entitlement';

const base64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const jsonPart = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));

export interface SigningKey {
  publicKey: JsonWebKey;
  /** A compact JWS over `payload` with this key. */
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function signingKey(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
    async sign(payload, header = { alg: 'ES256', typ: 'JWT' }) {
      const signed = `${jsonPart(header)}.${jsonPart(payload)}`;
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(signed));
      return `${signed}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}

/**
 * One device's localStorage entry, shared by the windows (entitlements) built on it: a write from one reaches the
 * others' `subscribe`, as the `storage` event does (never the writer's own, as in a browser).
 */
export class SharedLicenseStorage {
  value: StoredLicense | null = null;
  writes = 0;
  private readonly windows = new Set<{ listeners: Set<() => void> }>();

  /** The store one window sees. `failWrites` makes its writes throw, as a full or blocked storage does. */
  window(options: { failWrites?: boolean } = {}): LicenseStore & { listeners: Set<() => void> } {
    const listeners = new Set<() => void>();
    const view = { listeners };
    this.windows.add(view);
    return {
      listeners,
      read: () => this.value === null ? null : structuredClone(this.value),
      write: next => {
        if (options.failWrites) throw new Error('storage is full');
        this.value = structuredClone(next);
        this.writes += 1;
        for (const other of this.windows) {
          if (other !== view) for (const listener of other.listeners) listener();
        }
      },
      subscribe: listener => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
  }
}

/** Web Locks across the windows of one device: one task at a time, in the order asked. */
export function sharedLock(): LicenseLock & { held: () => boolean } {
  let tail: Promise<unknown> = Promise.resolve();
  let holding = false;
  const lock = (<T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      holding = true;
      try { return await task(); } finally { holding = false; }
    });
    tail = run.catch(() => undefined);
    return run;
  }) as LicenseLock & { held: () => boolean };
  lock.held = () => holding;
  return lock;
}

/** Let promises and WebCrypto settle. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
}
