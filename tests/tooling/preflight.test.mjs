import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  allowedCommunityPlugins,
  harnessPaths,
  markerContents,
  readInstalledBuild,
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

/** dist/mappy-ai-dev as `npm run harness:prepare:ai-dev` leaves it: the unlocked bundle beside the root manifest and styles. */
function addDevBuild(main = 'module.exports = {}; const marker = "mappy-ai-dev-unlock";\n') {
  mkdirSync(paths.devDistribution, { recursive: true });
  writeFileSync(join(paths.devDistribution, 'main.js'), main);
  for (const filename of ['manifest.json', 'styles.css']) {
    writeFileSync(join(paths.devDistribution, filename), readFileSync(join(root, filename)));
  }
  const releaseMainSha256 = createHash('sha256').update(readFileSync(join(root, 'main.js'))).digest('hex');
  writeJson(join(paths.devDistribution, 'build-info.json'), { id: 'mappy', version: '0.1.0', releaseMainSha256 });
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

function runScript(filename, ...args) {
  return spawnSync(process.execPath, [join('scripts', filename), ...args], { cwd: root, encoding: 'utf8' });
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
    addScripts('preflight.mjs', 'validate-release.mjs');
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
    addScripts('preflight.mjs', 'validate-release.mjs', 'prepare-test-vault.mjs', 'performance-fixtures.mjs');
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

  it('refuses a generated vault whose community-plugins.json is not a list of plugin IDs', () => {
    addVault({ mappy: true });
    const result = runScript('prepare-test-vault.mjs');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('community-plugins.json: expected an array of plugin IDs.');
    expect(readEnabled()).toEqual({ mappy: true });
  });
});

describe('the AI development build in the test vault (LEV-273, docs/architecture.md §11.6)', () => {
  beforeEach(() => {
    addScripts('preflight.mjs', 'validate-release.mjs', 'prepare-test-vault.mjs', 'performance-fixtures.mjs');
    cpSync(fixturesSource, paths.fixtureSource, { recursive: true });
  });

  it('reads a vault without .mappy-harness-build as holding the release build, which the plain preflight passes as before', () => {
    addVault(['mappy']);
    expect(readInstalledBuild(paths)).toBe('release');
    expect(runPreflight(paths)).toMatchObject({ build: 'release' });
    const result = runScript('preflight.mjs');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('main.js: ');
    expect(result.stdout).toContain('(source = dist = test-vault)');
  });

  it('installs dist/mappy-ai-dev with --ai-dev, records it, and leaves the release comparison to the release vault', () => {
    addDevBuild();
    const prepared = runScript('prepare-test-vault.mjs', '--ai-dev');
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(readFileSync(paths.buildMark, 'utf8')).toBe('ai-dev\n');
    expect(readFileSync(join(paths.installed, 'main.js'), 'utf8')).toContain('mappy-ai-dev-unlock');
    expect(runPreflight(paths, { build: 'ai-dev' })).toMatchObject({ build: 'ai-dev' });
    // The release preflight (and every case that needs it) refuses the unlocked vault instead of comparing it.
    expect(() => runPreflight(paths)).toThrow('test-vault holds the ai-dev build, not release; run npm run harness:prepare.');
    const plain = runScript('preflight.mjs');
    expect(plain.status).toBe(1);
    const dev = runScript('preflight.mjs', '--ai-dev');
    expect(dev.status, dev.stderr).toBe(0);
    expect(dev.stdout).toContain('Preflight passed: mappy 0.1.0 (ai-dev).');
    // Back to the release build: the plain prepare records it again.
    const back = runScript('prepare-test-vault.mjs');
    expect(back.status, back.stderr).toBe(0);
    expect(readFileSync(paths.buildMark, 'utf8')).toBe('release\n');
    expect(runPreflight(paths)).toMatchObject({ build: 'release' });
  });

  it('refuses to install a dist/mappy-ai-dev that lacks the unlock (a release bundle copied there)', () => {
    addDevBuild('module.exports = {};\n');
    const result = runScript('prepare-test-vault.mjs', '--ai-dev');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lacks the AI development unlock');
  });

  it('refuses an ai-dev bundle whose manifest is not the root one', () => {
    addDevBuild();
    writeFileSync(join(paths.devDistribution, 'manifest.json'), '{}\n');
    expect(() => runPreflight(paths, { build: 'ai-dev' })).toThrow();
    const result = runScript('prepare-test-vault.mjs', '--ai-dev');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest.json: source and dist/mappy-ai-dev differ');
  });

  it('refuses an ai-dev bundle left from other sources than the root build, or without its build info', () => {
    addDevBuild();
    // The root main.js was rebuilt (npm run package) after the ai-dev bundle: it is no longer the same sources.
    writeFileSync(join(root, 'main.js'), 'module.exports = { newer: true };\n');
    expect(() => runPreflight(paths, { build: 'ai-dev' })).toThrow();
    expect(runScript('prepare-test-vault.mjs', '--ai-dev').stderr).toContain('was not built from the sources of the root main.js');
    addDevBuild();
    rmSync(join(paths.devDistribution, 'build-info.json'));
    expect(runScript('prepare-test-vault.mjs', '--ai-dev').stderr).toContain('build-info.json');
  });

  it('refuses an unknown build record and unknown arguments', () => {
    addVault(['mappy']);
    writeFileSync(paths.buildMark, 'debug\n');
    expect(() => runPreflight(paths)).toThrow('Unknown harness build "debug"');
    expect(runScript('preflight.mjs', '--dev').status).toBe(1);
    expect(runScript('prepare-test-vault.mjs', '--dev').status).toBe(1);
  });
});
