// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowLicenseStore, LICENSE_STORAGE_KEY, parseStoredLicense } from '../../../src/ai/license/store';

afterEach(() => { window.localStorage.clear(); });

describe('the stored license (window.localStorage, mappy-ai-license)', () => {
  it('writes and reads one JSON entry under mappy-ai-license, shared by every vault of the device', () => {
    const store = createWindowLicenseStore();
    store.write({ deviceId: 'd', licenseCode: 'C', accessToken: 't', refreshSecret: 's' });
    expect(JSON.parse(window.localStorage.getItem(LICENSE_STORAGE_KEY)!)).toEqual({ deviceId: 'd', licenseCode: 'C', accessToken: 't', refreshSecret: 's' });
    expect(store.read()).toEqual({ deviceId: 'd', licenseCode: 'C', accessToken: 't', refreshSecret: 's' });
  });

  it.each([null, '', 'not json', '[]', '"text"', '{}', '{"deviceId":""}', '{"deviceId":7}'])('reads %j as nothing stored', text => {
    expect(parseStoredLicense(text)).toBeNull();
  });

  it('drops fields that are not non-empty strings', () => {
    expect(parseStoredLicense('{"deviceId":"d","accessToken":1,"refreshSecret":"","rejected":"no","extra":"x"}'))
      .toEqual({ deviceId: 'd', rejected: 'no' });
  });

  it('reads a storage that throws as nothing stored', () => {
    const throwing = { localStorage: { getItem: () => { throw new Error('blocked'); } } } as unknown as Window;
    expect(createWindowLicenseStore(throwing).read()).toBeNull();
  });

  it('hears another window write this key or clear the storage, and nothing else', () => {
    const store = createWindowLicenseStore();
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    window.dispatchEvent(new StorageEvent('storage', { key: LICENSE_STORAGE_KEY }));
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'mappy-ai-paths' }));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: LICENSE_STORAGE_KEY }));
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
