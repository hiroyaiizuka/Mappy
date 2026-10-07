import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  allowedCommunityPlugins,
  harnessPaths,
  markerContents,
  pluginFiles,
  runPreflight,
} from '../../scripts/preflight.mjs';

const scriptsSource = fileURLToPath(new URL('../../scripts', import.meta.url));
const fixturesSource = fileURLToPath(new URL('../fixtures', import.meta.url));
const excalidraw = 'obsidian-excalidraw-plugin';
let root;
let paths;

function writeJson(filename, value) {
  mkdirSync(join(filename, '..'), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

/** Root plugin files and the packaged copy `readHarnessBuild` compares them with. */
function addBuild() {
  writeFileSync(join(root, 'main.js'), 'module.exports = {};\n');
  writeFileSync(join(root, 'styles.css'), '.mappy { color: var(--text-normal); }\n');
  writeJson(join(root, 'manifest.json'), { id: 'mappy', name: 'Mappy', version: '0.1.0', minAppVersion: '1.6.7' });
  mkdirSync(paths.distribution, { recursive: true });
  for (const filename of pluginFiles) {
    writeFileSync(join(paths.distribution, filename), readFileSync(join(root, filename)));
  }
}

/** A vault as `harness:prepare` leaves it, with the given community plugins enabled. */
function addVault(enabled) {
  mkdirSync(paths.installed, { recursive: true });
  writeFileSync(paths.marker, markerContents);
  for (const filename of pluginFiles) {
    writeFileSync(join(paths.installed, filename), readFileSync(join(paths.distribution, filename)));
  }
  writeJson(paths.communityPlugins, enabled);
}

function readEnabled() {
  return JSON.parse(readFileSync(paths.communityPlugins, 'utf8'));
}

/** Copy the harness scripts under the temporary root so their own root check passes from there. */
function addScripts(...filenames) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const filename of filenames) {
    cpSync(join(scriptsSource, filename), join(root, 'scripts', filename));
  }
}

/** Runs a harness script from the temporary root, with `MAPPY_E2E_VAULT` only when `env` gives it. */
function runScript(filename, env = {}) {
  const inherited = { ...process.env };
  delete inherited.MAPPY_E2E_VAULT;
  return spawnSync(process.execPath, [join('scripts', filename)], { cwd: root, encoding: 'utf8', env: { ...inherited, ...env } });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mappy-preflight-test-')));
  paths = harnessPaths(root);
  addBuild();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('preflight community plugin check', () => {
  it('lists mappy and Excalidraw as the only plugins a generated vault may enable', () => {
    expect(allowedCommunityPlugins).toEqual(['mappy', excalidraw]);
  });

  it('passes a freshly prepared vault that enables only mappy', () => {
    addVault(['mappy']);
    const result = runPreflight(paths);
    expect(result).toMatchObject({ id: 'mappy', version: '0.1.0', enabledPlugins: ['mappy'] });
    expect(Object.keys(result.sha256)).toEqual(pluginFiles);
  });

  it('passes the M6 vault that enables mappy and Excalidraw', () => {
    addVault(['mappy', excalidraw]);
    expect(runPreflight(paths).enabledPlugins).toEqual(['mappy', excalidraw]);
  });

  it('rejects any other enabled plugin and names it', () => {
    addVault(['mappy', excalidraw, 'dataview']);
    expect(() => runPreflight(paths)).toThrow(/community-plugins\.json: .*dataview/u);
  });

  it('rejects a vault where mappy itself is not enabled', () => {
    addVault([excalidraw]);
    expect(() => runPreflight(paths)).toThrow('community-plugins.json: mappy must be enabled.');
  });

  it.each([{ mappy: true }, ['mappy', 1], 'mappy'])('rejects a community-plugins.json that is not a list of plugin IDs %j', (contents) => {
    addVault(contents);
    expect(() => runPreflight(paths)).toThrow('community-plugins.json: expected an array of plugin IDs.');
  });

  it('still refuses installed bytes that differ from the packaged build', () => {
    addVault(['mappy', excalidraw]);
    writeFileSync(join(paths.installed, 'main.js'), 'stale\n');
    expect(() => runPreflight(paths)).toThrow('main.js: installed bytes differ; run npm run harness:prepare.');
  });
});

describe('preflight CLI', () => {
  beforeEach(() => {
    addScripts('preflight.mjs');
  });

  it('passes the Excalidraw-enabled vault and reports the enabled plugins', () => {
    addVault(['mappy', excalidraw]);
    const result = runScript('preflight.mjs');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Preflight passed: mappy 0.1.0.');
    expect(result.stdout).toContain(`Enabled community plugins: mappy, ${excalidraw}.`);
  });

  it('exits nonzero when an unknown plugin is enabled, even though the hashes match', () => {
    addVault(['mappy', 'dataview']);
    const result = runScript('preflight.mjs');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Preflight failed: community-plugins.json:');
    expect(result.stderr).toContain('dataview');
  });
});

describe('prepare-test-vault CLI', () => {
  beforeEach(() => {
    addScripts('preflight.mjs', 'prepare-test-vault.mjs', 'performance-fixtures.mjs');
    cpSync(fixturesSource, paths.fixtureSource, { recursive: true });
  });

  it('enables only mappy in a new vault', () => {
    const result = runScript('prepare-test-vault.mjs');
    expect(result.status, result.stderr).toBe(0);
    expect(readEnabled()).toEqual(['mappy']);
    expect(result.stdout).toContain('Enabled community plugins: mappy.');
  });

  it('keeps Excalidraw enabled when re-run on the M6 vault', () => {
    addVault(['mappy', excalidraw]);
    const result = runScript('prepare-test-vault.mjs');
    expect(result.status, result.stderr).toBe(0);
    expect(readEnabled()).toEqual(['mappy', excalidraw]);
    expect(result.stdout).toContain(`Enabled community plugins: mappy, ${excalidraw}.`);
  });

  it('drops any other plugin on re-run, as it always reset the list, and re-enables mappy', () => {
    addVault([excalidraw, 'dataview']);
    const result = runScript('prepare-test-vault.mjs');
    expect(result.status, result.stderr).toBe(0);
    expect(readEnabled()).toEqual(['mappy', excalidraw]);
  });

  it('prepares the second vault MAPPY_E2E_VAULT names, and leaves test-vault alone (LEV-327)', () => {
    const result = runScript('prepare-test-vault.mjs', { MAPPY_E2E_VAULT: 'test-vault-b' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Prepared test-vault-b with mappy 0.1.0.');
    const second = harnessPaths(root, join(root, 'test-vault-b'));
    expect(readFileSync(second.marker, 'utf8')).toBe(markerContents);
    expect(readFileSync(join(second.installed, 'main.js'), 'utf8')).toBe('module.exports = {};\n');
    expect(existsSync(paths.vault)).toBe(false);
    const preflight = runScript('preflight.mjs', { MAPPY_E2E_VAULT: join(root, 'test-vault-b') });
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(preflight.stdout).toContain('(source = dist = test-vault-b)');
  });

  it('refuses a MAPPY_E2E_VAULT outside the project, and writes nothing there', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mappy-outside-')));
    try {
      const result = runScript('prepare-test-vault.mjs', { MAPPY_E2E_VAULT: join(outside, 'test-vault-b') });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('MAPPY_E2E_VAULT must be test-vault or test-vault-<name> directly in');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a generated vault whose community-plugins.json is not a list of plugin IDs', () => {
    addVault({ mappy: true });
    const result = runScript('prepare-test-vault.mjs');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('community-plugins.json: expected an array of plugin IDs.');
    expect(readEnabled()).toEqual({ mappy: true });
  });
});
