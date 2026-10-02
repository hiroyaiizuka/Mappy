/**
 * Checking an access token offline (docs/architecture.md §11.6「検証」): the signature against the public key
 * bundled with the plugin, and the expiry against this device's clock. No network, no Obsidian.
 *
 * PROVISIONAL CONTRACT (LEV-273, 2026-10-02): the engineer's API contract has not arrived, so the token is assumed
 * to be a compact JWS signed with ES256 (ECDSA P-256 / SHA-256, which every Chromium Obsidian ships has in
 * WebCrypto): `base64url(header).base64url(payload).base64url(signature)`, the header `{"alg":"ES256"}`, the
 * payload carrying `exp` in seconds since the epoch, the signature the 64-byte `r‖s` that JWS and WebCrypto both
 * use. When the contract arrives, this file and LICENSE_PUBLIC_KEY change to match it.
 *
 * The code is plain on purpose (community-submission #47: no obfuscation). The check is a deterrent, not a lock:
 * the code is MIT and public, and the device clock can be turned back (product-plan §5 M9).
 */

/**
 * The public key the release build verifies with. PROVISIONAL: a P-256 key generated for LEV-273 whose private half
 * was thrown away, so no token verifies against it until the engineer's real key replaces it. Tests pass their own.
 */
export const LICENSE_PUBLIC_KEY: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'E9o603Tql8_d8W_ufJY9MsnGgmg9Jmnf83pisENyG-I',
  y: 'v34cnGXM6rrp50oJIapReNW0wpCGVRE6DWPG6e37_rk',
};

export type TokenCheck =
  /** Signed by the key; `expiresAt` in milliseconds since the epoch. */
  | { kind: 'signed'; expiresAt: number }
  /** Not a token this key signed, or not a token at all. */
  | { kind: 'unsigned'; reason: string };

export interface TokenVerifier {
  verify(token: string): Promise<TokenCheck>;
}

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - text.length % 4) % 4);
  try {
    return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function base64UrlJson(text: string): unknown {
  const bytes = base64UrlBytes(text);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A verifier over WebCrypto. The key is imported once, on the first token. */
export function createTokenVerifier(publicKey: JsonWebKey = LICENSE_PUBLIC_KEY): TokenVerifier {
  let imported: Promise<CryptoKey | null> | null = null;
  const key = (): Promise<CryptoKey | null> => {
    imported ??= crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      .catch(() => null);
    return imported;
  };
  return {
    async verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3) return { kind: 'unsigned', reason: 'malformed token' };
      const [headerText = '', payloadText = '', signatureText = ''] = parts;
      const header = base64UrlJson(headerText);
      if (!isRecord(header) || header.alg !== 'ES256') return { kind: 'unsigned', reason: 'unsupported token' };
      const payload = base64UrlJson(payloadText);
      if (!isRecord(payload) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        return { kind: 'unsigned', reason: 'malformed token' };
      }
      const signature = base64UrlBytes(signatureText);
      if (!signature || signature.length !== 64) return { kind: 'unsigned', reason: 'malformed signature' };
      const verifyKey = await key();
      if (!verifyKey) return { kind: 'unsigned', reason: 'no usable public key' };
      const signed = new TextEncoder().encode(`${headerText}.${payloadText}`);
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, signature, signed)
        .catch(() => false);
      return valid ? { kind: 'signed', expiresAt: payload.exp * 1000 } : { kind: 'unsigned', reason: 'bad signature' };
    },
  };
}
