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
 * - refusal: 400–499 except 408 and 429, with `{"error": "<reason>"}`; anything else (no answer, 408, 429, 5xx,
 *   a body that is not the success shape) is "could not reach" and may be retried.
 * The base is a `.invalid` host (RFC 2606), which never resolves, so a build carrying this contract cannot send a
 * code anywhere until the real endpoint replaces it.
 */
export const LICENSE_SERVER = 'https://license.mappy.invalid';

export interface IssuedTokens { accessToken: string; refreshSecret: string }

export interface LicenseClient {
  register(licenseCode: string, deviceId: string): Promise<IssuedTokens>;
  refresh(deviceId: string, refreshSecret: string): Promise<IssuedTokens>;
}

/** Why a request did not return tokens: `unreachable` may be retried, `rejected` is the server's answer. */
export class LicenseRequestError extends Error {
  constructor(readonly kind: 'unreachable' | 'rejected', readonly reason: string) {
    super(reason);
    this.name = 'LicenseRequestError';
  }
}

type Request = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

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

export function createLicenseClient(request: Request = requestUrl, server: string = LICENSE_SERVER): LicenseClient {
  const post = async (path: string, body: Record<string, string>): Promise<IssuedTokens> => {
    let response: RequestUrlResponse;
    try {
      response = await request({
        url: `${server}${path}`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify(body),
        throw: false,
      });
    } catch (error) {
      throw new LicenseRequestError('unreachable', error instanceof Error && error.message ? error.message : 'network error');
    }
    const { status } = response;
    const json = readJson(response);
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      throw new LicenseRequestError('rejected', field(json, 'error') ?? `HTTP ${status}`);
    }
    if (status !== 200) throw new LicenseRequestError('unreachable', `HTTP ${status}`);
    const accessToken = field(json, 'accessToken');
    const refreshSecret = field(json, 'refreshSecret');
    if (!accessToken || !refreshSecret) throw new LicenseRequestError('unreachable', 'unexpected response');
    return { accessToken, refreshSecret };
  };
  return {
    register: (licenseCode, deviceId) => post('/v1/register', { licenseCode, deviceId }),
    refresh: (deviceId, refreshSecret) => post('/v1/refresh', { deviceId, refreshSecret }),
  };
}
