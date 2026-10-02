/**
 * Where the license lives (docs/architecture.md §11.6「保存先」): `window.localStorage`, one entry per device and
 * shared by every vault, because the license counts devices (an entry per vault would register each vault as a
 * device). Not `data.json`: sync would copy the refresh secret, which rotates on every refresh, to other devices.
 * Every caller goes through `LicenseStore`, so moving to `app.saveLocalStorage` is a new implementation only.
 * Other plugins in the same Obsidian can read either place (README #45).
 */

export const LICENSE_STORAGE_KEY = 'mappy-ai-license';

/**
 * What one device keeps. `rejected` is the server's last refusal, kept so a reload still shows it. `unverified` is
 * why a token the server had just issued did not verify with the bundled key, kept so a reload does not read it as
 * one to refresh again (a plugin update whose key verifies it clears it by verifying).
 */
export interface StoredLicense {
  deviceId: string;
  licenseCode?: string;
  accessToken?: string;
  refreshSecret?: string;
  rejected?: string;
  unverified?: string;
}

export interface LicenseStore {
  read(): StoredLicense | null;
  write(next: StoredLicense): void;
  /** Another window of this device wrote the entry (the `storage` event). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;

/** The stored text as a license, or null when it is missing or not one (hand-edited, from another build). */
export function parseStoredLicense(text: string | null): StoredLicense | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const deviceId = optionalString(record.deviceId);
  if (!deviceId) return null;
  const license: StoredLicense = { deviceId };
  const licenseCode = optionalString(record.licenseCode);
  const accessToken = optionalString(record.accessToken);
  const refreshSecret = optionalString(record.refreshSecret);
  const rejected = optionalString(record.rejected);
  const unverified = optionalString(record.unverified);
  if (licenseCode) license.licenseCode = licenseCode;
  if (accessToken) license.accessToken = accessToken;
  if (refreshSecret) license.refreshSecret = refreshSecret;
  if (rejected) license.rejected = rejected;
  if (unverified) license.unverified = unverified;
  return license;
}

/**
 * `window.localStorage` of the plugin's window. A storage that throws (blocked, full) reads as nothing stored and
 * lets the write's error through to the caller, which reports it.
 */
export function createWindowLicenseStore(win: Window = window): LicenseStore {
  return {
    read() {
      try {
        return parseStoredLicense(win.localStorage.getItem(LICENSE_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    write(next) {
      win.localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(next));
    },
    subscribe(listener) {
      const onStorage = (event: StorageEvent): void => {
        // `key` is null when another window cleared the whole storage.
        if (event.key === LICENSE_STORAGE_KEY || event.key === null) listener();
      };
      win.addEventListener('storage', onStorage);
      return () => { win.removeEventListener('storage', onStorage); };
    },
  };
}
