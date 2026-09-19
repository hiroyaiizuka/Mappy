import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bumpVersion } from '../../scripts/version-bump.mjs';
import { validateRelease } from '../../scripts/validate-release.mjs';

const cliPath = fileURLToPath(new URL('../../scripts/version-bump.mjs', import.meta.url));
let root;

function writeJson(filename, value) {
  writeFileSync(join(root, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function readText(filename) {
  return readFileSync(join(root, filename), 'utf8');
}

function readJson(filename) {
  return JSON.parse(readText(filename));
}

/** What `npm version <x.y.z>` does before it runs the `version` script. */
function npmBumpsPackageFiles(version) {
  const packageJson = readJson('package.json');
  packageJson.version = version;
  writeJson('package.json', packageJson);
  const lockfile = readJson('package-lock.json');
  lockfile.version = version;
  lockfile.packages[''].version = version;
  writeJson('package-lock.json', lockfile);
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_package_version: undefined, ...env },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mappy-version-bump-test-'));
  writeJson('package.json', { name: 'mappy', version: '0.0.1' });
  writeJson('manifest.json', {
    id: 'mappy', name: 'Mappy', version: '0.0.1', minAppVersion: '1.8.7',
    description: 'Edit notes as mind maps.', author: 'Example author', isDesktopOnly: false,
  });
  writeJson('versions.json', { '0.0.1': '1.8.7' });
  writeJson('package-lock.json', {
    name: 'mappy', version: '0.0.1', lockfileVersion: 3,
    packages: { '': { name: 'mappy', version: '0.0.1' } },
  });
  writeFileSync(join(root, 'LICENSE'), 'Test license\n');
  writeFileSync(join(root, 'README.md'), '# Mappy\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bumpVersion', () => {
  it('points manifest.json at the new version and appends it to versions.json with the current minAppVersion', () => {
    expect(bumpVersion(root, '0.1.0')).toEqual({ version: '0.1.0', minAppVersion: '1.8.7' });
    expect(readJson('manifest.json')).toMatchObject({ version: '0.1.0', minAppVersion: '1.8.7' });
    expect(readJson('versions.json')).toEqual({ '0.0.1': '1.8.7', '0.1.0': '1.8.7' });
  });

  it('leaves the rest of manifest.json and the earlier versions untouched, in their original order', () => {
    writeJson('versions.json', { '0.0.1': '1.6.7', '0.0.2': '1.8.7' });
    const before = readJson('manifest.json');
    bumpVersion(root, '0.1.0');
    const after = readJson('manifest.json');
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect({ ...after, version: before.version }).toEqual(before);
    expect(Object.entries(readJson('versions.json'))).toEqual([
      ['0.0.1', '1.6.7'], ['0.0.2', '1.8.7'], ['0.1.0', '1.8.7'],
    ]);
  });

  it('writes the same 2-space JSON with a trailing newline that the repository files use', () => {
    bumpVersion(root, '0.1.0');
    for (const filename of ['manifest.json', 'versions.json']) {
      const text = readText(filename);
      expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    }
  });

  it('produces metadata that passes release validation once npm has bumped package.json and the lockfile', () => {
    npmBumpsPackageFiles('0.1.0');
    expect(validateRelease(root)).not.toEqual([]);
    bumpVersion(root, '0.1.0');
    expect(validateRelease(root)).toEqual([]);
  });

  it('records a raised minAppVersion for the new version and overwrites a stale entry on a re-run', () => {
    writeJson('versions.json', { '0.0.1': '1.8.7', '0.1.0': '1.8.7' });
    const manifest = readJson('manifest.json');
    manifest.minAppVersion = '1.9.0';
    writeJson('manifest.json', manifest);
    expect(bumpVersion(root, '0.1.0')).toEqual({ version: '0.1.0', minAppVersion: '1.9.0' });
    expect(readJson('versions.json')).toEqual({ '0.0.1': '1.8.7', '0.1.0': '1.9.0' });
  });

  it.each(['v0.1.0', '0.1', '01.0.0', '0.1.0-beta.1', '0.1.0 ', '', undefined, 1])(
    'rejects %j because release tags must be x.y.z without a prefix', (version) => {
      expect(() => bumpVersion(root, version)).toThrow(/x\.y\.z format without a "v" prefix/u);
      expect(readJson('manifest.json').version).toBe('0.0.1');
      expect(readJson('versions.json')).toEqual({ '0.0.1': '1.8.7' });
    },
  );

  it('refuses to record an invalid minAppVersion instead of writing it into versions.json', () => {
    const manifest = readJson('manifest.json');
    manifest.minAppVersion = '1.8';
    writeJson('manifest.json', manifest);
    expect(() => bumpVersion(root, '0.1.0')).toThrow('manifest.json.minAppVersion');
    expect(readJson('manifest.json').version).toBe('0.0.1');
    expect(readJson('versions.json')).toEqual({ '0.0.1': '1.8.7' });
  });

  it('reports a missing or malformed file by name', () => {
    rmSync(join(root, 'versions.json'));
    expect(() => bumpVersion(root, '0.1.0')).toThrow('versions.json: file is missing.');
    writeFileSync(join(root, 'versions.json'), '[]\n');
    expect(() => bumpVersion(root, '0.1.0')).toThrow('versions.json: expected a JSON object.');
    writeFileSync(join(root, 'manifest.json'), '{ not json');
    expect(() => bumpVersion(root, '0.1.0')).toThrow('manifest.json: invalid JSON.');
  });
});

describe('version-bump CLI', () => {
  it('reads the new version from npm_package_version, as the npm `version` script does', () => {
    npmBumpsPackageFiles('0.2.0');
    const result = runCli([], { npm_package_version: '0.2.0' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('manifest.json and versions.json now declare 0.2.0 (minAppVersion 1.8.7).');
    expect(readJson('manifest.json').version).toBe('0.2.0');
    expect(validateRelease(root)).toEqual([]);
  });

  it('prefers an explicit argument over the environment', () => {
    const result = runCli(['0.3.0'], { npm_package_version: '0.2.0' });
    expect(result.status).toBe(0);
    expect(readJson('manifest.json').version).toBe('0.3.0');
    expect(readJson('versions.json')).toEqual({ '0.0.1': '1.8.7', '0.3.0': '1.8.7' });
  });

  it('fails without a version and leaves the files alone', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Version bump: expected a release version in x.y.z format');
    expect(readJson('manifest.json').version).toBe('0.0.1');
    expect(readJson('versions.json')).toEqual({ '0.0.1': '1.8.7' });
  });

  it('fails on a prerelease or prefixed version so `npm version` stops before committing', () => {
    for (const version of ['v0.2.0', '0.2.0-beta.1']) {
      const result = runCli([], { npm_package_version: version });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(JSON.stringify(version));
    }
    expect(readJson('manifest.json').version).toBe('0.0.1');
  });
});
