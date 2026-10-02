import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

/**
 * The only place Mappy talks to the license server (docs/architecture.md §11.6「通信」, community-submission #43):
 * registering a code and refreshing a token, both through Obsidian's `requestUrl` (never `fetch`). Only
 * `entitlement.ts` imports this file (tests/tooling/ai-boundaries.test.mjs). What goes out is the license code, the
 * device ID and the refresh secret, and nothing else: no usage, counts or versions.
 *
 * PROVISIONAL CONTRACT (LEV-273, 2026-10-02), until the engineer's arrives:
 * - register: `POST {base}/v1/register`, body `{"licenseCode","deviceId"}`
 * - refresh:  `POST {base}/v1/refresh`,  body `{"deviceId","refreshSecret"}`
 * - success: 200 with `{"accessToken","refreshSecret"}` (the refresh secret rotates on every call)
 * - refusal: 400–499 except 408 and 429, with the server's own body `{"error": "<reason>"}`; anything else (no
 *   answer, 408, 429, 5xx, a 4xx without that body — a proxy's 407, a firewall's 403, a moved endpoint's 404 —, a
 *   body that is not the success shape) is "could not reach" and may be retried. A refusal makes the device
 *   `invalid`, so only the license server's own answer counts as one.
 * The base is a `.invalid` host (RFC 2606), which never resolves, so a build carrying this contract cannot send a
 * code anywhere until the real endpoint replaces it.
 */
export const LICENSE_SERVER = 'https://license.mappy.invalid';

export interface IssuedTokens { accessToken: string; refreshSecret: string }

export interface LicenseClient {
  register(licenseCode: string, deviceId: string): Promise<IssuedTokens>;
  refresh(deviceId: string, refreshSecret: string): Promise<IssuedTokens>;
}

/**
 * Why a request could not get an answer, as codes the settings word in the UI's language. `http-<status>` carries
 * the status. A refusal's reason is the server's own text and is shown as it is.
 */
export const NETWORK_REASONS = {
  timeout: 'net:timeout',
  error: 'net:error',
  unexpected: 'net:unexpected-response',
  waiting: 'net:waiting',
  http: (status: number) => `net:http-${status}`,
} as const;

/**
 * Why a request did not return tokens: `unreachable` may be retried, `rejected` is the server's answer. A request
 * given up on after the timeout is still on its way: `late` settles with what the server answered in the end, so a
 * refresh secret the server rotated meanwhile is not lost.
 */
export class LicenseRequestError extends Error {
  constructor(readonly kind: 'unreachable' | 'rejected', readonly reason: string, readonly late?: Promise<IssuedTokens>) {
    super(reason);
    this.name = 'LicenseRequestError';
  }
}

type Request = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

/**
 * How long one request may take. `requestUrl` has no timeout of its own, and register and refresh hold the lock
 * every window of the device waits on, so a server that never answers must not hold it for good.
 */
export const LICENSE_TIMEOUT_MS = 20_000;

function readJson(response: RequestUrlResponse): unknown {
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object') return null;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' && item !== '' ? item : null;
}

export function createLicenseClient(request: Request = requestUrl, server: string = LICENSE_SERVER, timeoutMs = LICENSE_TIMEOUT_MS): LicenseClient {
  const send = async (path: string, body: Record<string, string>): Promise<IssuedTokens> => {
    let response: RequestUrlResponse;
    try {
      response = await request({
        url: `${server}${path}`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify(body),
        throw: false,
      });
    } catch {
      throw new LicenseRequestError('unreachable', NETWORK_REASONS.error);
    }
    const { status } = response;
    const json = readJson(response);
    const refusal = field(json, 'error');
    if (status >= 400 && status < 500 && status !== 408 && status !== 429 && refusal) {
      throw new LicenseRequestError('rejected', refusal);
    }
    if (status !== 200) throw new LicenseRequestError('unreachable', NETWORK_REASONS.http(status));
    const accessToken = field(json, 'accessToken');
    const refreshSecret = field(json, 'refreshSecret');
    if (!accessToken || !refreshSecret) throw new LicenseRequestError('unreachable', NETWORK_REASONS.unexpected);
    return { accessToken, refreshSecret };
  };
  const post = async (path: string, body: Record<string, string>): Promise<IssuedTokens> => {
    const sent = send(path, body);
    let timer: number | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => { reject(new LicenseRequestError('unreachable', NETWORK_REASONS.timeout, sent)); }, timeoutMs);
    });
    // The late answer is handed over with the timeout; nobody else waits on it, so its failure is not unhandled.
    sent.catch(() => undefined);
    try {
      return await Promise.race([sent, timeout]);
    } finally {
      window.clearTimeout(timer);
    }
  };
  return {
    register: (licenseCode, deviceId) => post('/v1/register', { licenseCode, deviceId }),
    refresh: (deviceId, refreshSecret) => post('/v1/refresh', { deviceId, refreshSecret }),
  };
}
