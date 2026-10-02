// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { createLicenseClient, LICENSE_SERVER, LicenseRequestError } from '../../../src/ai/license/client';

function answer(status: number, body: unknown): RequestUrlResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text, headers: {}, arrayBuffer: new ArrayBuffer(0), json: undefined as unknown };
}

function client(response: RequestUrlResponse | Error) {
  const request = vi.fn<(param: RequestUrlParam) => Promise<RequestUrlResponse>>(() => response instanceof Error ? Promise.reject(response) : Promise.resolve(response));
  return { request, client: createLicenseClient(request) };
}

const tokens = { accessToken: 'a.b.c', refreshSecret: 'next-secret' };

describe('the license client (provisional contract, src/ai/license/client.ts)', () => {
  it('registers with a POST of the code and the device ID only, through requestUrl', async () => {
    const { request, client: license } = client(answer(200, tokens));
    expect(await license.register('CODE-1', 'device-1')).toEqual(tokens);
    expect(request).toHaveBeenCalledTimes(1);
    const [param] = request.mock.calls[0]!;
    expect(param).toMatchObject({ url: `${LICENSE_SERVER}/v1/register`, method: 'POST', contentType: 'application/json', throw: false });
    expect(JSON.parse(param.body as string)).toEqual({ licenseCode: 'CODE-1', deviceId: 'device-1' });
  });

  it('refreshes with a POST of the device ID and the refresh secret only', async () => {
    const { request, client: license } = client(answer(200, tokens));
    expect(await license.refresh('device-1', 'old-secret')).toEqual(tokens);
    const [param] = request.mock.calls[0]!;
    expect(param.url).toBe(`${LICENSE_SERVER}/v1/refresh`);
    expect(JSON.parse(param.body as string)).toEqual({ deviceId: 'device-1', refreshSecret: 'old-secret' });
  });

  it('sends to a host that never resolves until the real contract arrives', () => {
    expect(new URL(LICENSE_SERVER).hostname.endsWith('.invalid')).toBe(true);
  });

  it.each([
    [400, { error: 'unknown code' }, 'unknown code'],
    [403, { error: 'too many devices' }, 'too many devices'],
    [410, { error: 'license gone' }, 'license gone'],
  ])('reads %i as the server refusing', async (status, body, reason) => {
    const { client: license } = client(answer(status, body));
    const failure = await license.register('CODE', 'device').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LicenseRequestError);
    expect(failure).toMatchObject({ kind: 'rejected', reason });
  });

  it.each([
    [408, {}], [429, { error: 'slow down' }], [404, 'Not Found'], [407, ''], [403, '<html>blocked</html>'], [410, 'gone'], [500, { error: 'boom' }], [503, ''], [200, { accessToken: 'only' }], [200, 'not json'], [204, ''],
  ])('reads %i %j as not reached, to try again', async (status, body) => {
    const { client: license } = client(answer(status, body));
    await expect(license.refresh('device', 'secret')).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('gives up on a server that never answers, as not reached, so the lock it holds is let go', async () => {
    vi.useFakeTimers();
    try {
      const license = createLicenseClient(() => new Promise(() => undefined), LICENSE_SERVER, 1000);
      const failing = license.refresh('device', 'secret').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await failing).toMatchObject({ kind: 'unreachable', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a request that throws (offline, DNS) as not reached', async () => {
    const { client: license } = client(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await expect(license.register('CODE', 'device')).rejects.toMatchObject({ kind: 'unreachable', reason: 'net::ERR_NAME_NOT_RESOLVED' });
  });
});
