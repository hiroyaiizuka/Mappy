import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bumpVersion } from '../../scripts/bump-version.mjs';
import { validateRelease } from '../../scripts/validate-release.mjs';

const cliPath = fileURLToPath(new URL('../../scripts/bump-version.mjs', import.meta.url));
let root;

function writeJson(filename, value) {
  writeFileSync(join(root, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filename) {
  return JSON.parse(readFileSync(join(root, filename), 'utf8'));
}

function runCli(args, env) {
  // vitest itself runs under npm, so the parent environment already carries npm_package_version.
  const childEnv = { ...process.env, ...env };
  if (!('npm_package_version' in env)) delete childEnv.npm_package_version;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: 'utf8', env: childEnv });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mappy-bump-test-'));
  writeJson('manifest.json', {
    id: 'mappy', name: 'Mappy', version: '0.1.0', minAppVersion: '1.6.7',
    description: 'Edit notes as mind maps.', author: 'Example author', isDesktopOnly: false,
  });
  writeJson('versions.json', { '0.1.0': '1.6.7' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('version bump', () => {
  it('points manifest.json at the new version and records its minimum app version', () => {
    expect(bumpVersion(root, '0.2.0')).toEqual({ version: '0.2.0', minAppVersion: '1.6.7' });
    expect(readJson('manifest.json')).toMatchObject({ version: '0.2.0', minAppVersion: '1.6.7' });
    expect(readJson('versions.json')).toEqual({ '0.1.0': '1.6.7', '0.2.0': '1.6.7' });
  });

  it('keeps the key order and two-space formatting of the checked-in files', () => {
    const before = readFileSync(join(root, 'manifest.json'), 'utf8');
    bumpVersion(root, '0.2.0');
    expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe(before.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    expect(readFileSync(join(root, 'versions.json'), 'utf8')).toBe('{\n  "0.1.0": "1.6.7",\n  "0.2.0": "1.6.7"\n}\n');
  });

  it('leaves the metadata aligned for release validation once npm has bumped package.json', () => {
    writeJson('package.json', { name: 'mappy-dev', version: '0.2.0' });
    writeJson('package-lock.json', {
      name: 'mappy-dev', version: '0.2.0', lockfileVersion: 3,
      packages: { '': { name: 'mappy-dev', version: '0.2.0' } },
    });
    writeFileSync(join(root, 'LICENSE'), 'Test license\n');
    writeFileSync(join(root, 'README.md'), '# Mappy\n');
    expect(validateRelease(root)).toContain('package.json.version: must match manifest.json.version.');
    bumpVersion(root, '0.2.0');
    expect(validateRelease(root)).toEqual([]);
  });

  it.each(['v0.2.0', '0.2', '01.2.0', '0.2.0-beta.1', '', undefined])('rejects %j, which the release workflow would never build', (version) => {
    expect(() => bumpVersion(root, version)).toThrow('x.y.z');
    expect(readJson('manifest.json').version).toBe('0.1.0');
    expect(readJson('versions.json')).toEqual({ '0.1.0': '1.6.7' });
  });

  it('refuses to record a malformed minimum app version', () => {
    writeJson('manifest.json', { id: 'mappy', version: '0.1.0', minAppVersion: 'latest' });
    expect(() => bumpVersion(root, '0.2.0')).toThrow('manifest.json.minAppVersion');
    expect(readJson('manifest.json').version).toBe('0.1.0');
    expect(readJson('versions.json')).toEqual({ '0.1.0': '1.6.7' });
  });

  it('reports a missing or broken versions.json instead of recreating it', () => {
    rmSync(join(root, 'versions.json'));
    expect(() => bumpVersion(root, '0.2.0')).toThrow('versions.json: file is missing');
    writeFileSync(join(root, 'versions.json'), '[]\n');
    expect(() => bumpVersion(root, '0.2.0')).toThrow('versions.json: expected a JSON object');
    expect(readJson('manifest.json').version).toBe('0.1.0');
  });
});

describe('version bump CLI', () => {
  it('takes the new version from npm_package_version when run as the npm version hook', () => {
    const result = runCli([], { npm_package_version: '0.2.0' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0.2.0');
    expect(readJson('manifest.json').version).toBe('0.2.0');
    expect(readJson('versions.json')).toEqual({ '0.1.0': '1.6.7', '0.2.0': '1.6.7' });
  });

  it('prefers an explicit argument over the environment', () => {
    const result = runCli(['0.3.0'], { npm_package_version: '0.2.0' });
    expect(result.status).toBe(0);
    expect(readJson('manifest.json').version).toBe('0.3.0');
  });

  it('exits nonzero without touching files when no valid version is given', () => {
    const missing = runCli([], {});
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Version bump: expected a release version');

    const prefixed = runCli(['v0.2.0'], {});
    expect(prefixed.status).toBe(1);
    expect(prefixed.stderr).toContain('x.y.z');
    expect(readJson('manifest.json').version).toBe('0.1.0');
    expect(readJson('versions.json')).toEqual({ '0.1.0': '1.6.7' });
  });
});
