import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const pluginFiles = ['main.js', 'manifest.json', 'styles.css'];
export const markerContents = 'Mappy generated test vault v1\n';
/** Community plugins a generated vault may enable: mappy, and Excalidraw for the M6 cases (E23–E27, E30, E33). */
export const allowedCommunityPlugins = ['mappy', 'obsidian-excalidraw-plugin'];

export function harnessPaths(root) {
  const vault = join(root, 'test-vault');
  return {
    root,
    vault,
    marker: join(vault, '.mappy-generated'),
    distribution: join(root, 'dist', 'mappy'),
    installed: join(vault, '.obsidian', 'plugins', 'mappy'),
    communityPlugins: join(vault, '.obsidian', 'community-plugins.json'),
    fixtureSource: join(root, 'tests', 'fixtures'),
    fixtureTarget: join(vault, 'Fixtures'),
  };
}

export function getHarnessPaths() {
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (realpathSync(process.cwd()) !== root) {
    throw new Error('Run this command from the Mappy project root.');
  }
  return harnessPaths(root);
}

/** Check every path component, so a symlinked parent cannot redirect a write. */
export function assertSafePath(root, target, kind, { optional = false } = {}) {
  const path = relative(root, resolve(target));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Expected a path inside the project: ${target}`);
  }
  const segments = path.split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT' && optional) return false;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing a symbolic link: ${current}`);
    }
    const expected = index === segments.length - 1 ? kind : 'directory';
    if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Expected a regular ${expected}: ${current}`);
    }
    if (expected === 'file' && stat.nlink !== 1) {
      throw new Error(`Refusing a hard-linked file: ${current}`);
    }
  }
  return true;
}

export function readSafeFile(root, filename) {
  assertSafePath(root, filename, 'file');
  return readFileSync(filename);
}

export function assertGeneratedVault(paths) {
  assertSafePath(paths.root, paths.vault, 'directory');
  if (readSafeFile(paths.root, paths.marker).toString('utf8') !== markerContents) {
    throw new Error('test-vault is not a recognized Mappy generated vault.');
  }
}

/** Read `.obsidian/community-plugins.json`; when optional, a missing file counts as nothing enabled. */
export function readCommunityPlugins(paths, { optional = false } = {}) {
  if (!assertSafePath(paths.root, paths.communityPlugins, 'file', { optional })) return [];
  const enabled = JSON.parse(readFileSync(paths.communityPlugins).toString('utf8'));
  if (!Array.isArray(enabled) || !enabled.every((id) => typeof id === 'string')) {
    throw new Error('community-plugins.json: expected an array of plugin IDs.');
  }
  return enabled;
}

/** Only mappy and Excalidraw may take part in a real-vault run; anything else fails, so it cannot go unnoticed. */
export function assertCommunityPlugins(enabled) {
  if (!enabled.includes('mappy')) {
    throw new Error('community-plugins.json: mappy must be enabled.');
  }
  const unknown = enabled.filter((id) => !allowedCommunityPlugins.includes(id));
  if (unknown.length > 0) {
    throw new Error(`community-plugins.json: only ${allowedCommunityPlugins.join(' and ')} may be enabled; found ${unknown.join(', ')}.`);
  }
}

function parseManifest(contents, label) {
  const manifest = JSON.parse(contents.toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${label}: expected a manifest object.`);
  }
  if (typeof manifest.id !== 'string'
    || !/^[a-z]+(?:-[a-z]+)*$/u.test(manifest.id)
    || manifest.id.includes('obsidian') || manifest.id.endsWith('plugin')) {
    throw new Error(`${label}: invalid plugin ID.`);
  }
  if (manifest.id !== 'mappy') {
    throw new Error(`${label}: this harness only supports the mappy plugin.`);
  }
  if (typeof manifest.version !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(manifest.version)) {
    throw new Error(`${label}: expected a version in x.y.z format.`);
  }
  return manifest;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

/** Verify the packaged build before preparing or checking a generated vault. */
export function readHarnessBuild(paths) {
  const files = new Map();
  for (const filename of pluginFiles) {
    const source = readSafeFile(paths.root, join(paths.root, filename));
    const distribution = readSafeFile(paths.root, join(paths.distribution, filename));
    if (sha256(source) !== sha256(distribution)) {
      throw new Error(`${filename}: source and dist/mappy differ; run npm run package.`);
    }
    files.set(filename, distribution);
  }
  const manifest = parseManifest(files.get('manifest.json'), 'dist/mappy/manifest.json');
  return { files, manifest };
}

export function runPreflight(paths) {
  assertGeneratedVault(paths);
  const build = readHarnessBuild(paths);
  const hashes = {};
  for (const filename of pluginFiles) {
    const installed = readSafeFile(paths.root, join(paths.installed, filename));
    const expected = sha256(build.files.get(filename));
    if (sha256(installed) !== expected) {
      throw new Error(`${filename}: installed bytes differ; run npm run harness:prepare.`);
    }
    hashes[filename] = expected;
  }
  const installedManifest = parseManifest(
    readSafeFile(paths.root, join(paths.installed, 'manifest.json')),
    'test-vault manifest.json',
  );
  if (installedManifest.version !== build.manifest.version) {
    throw new Error('Installed and packaged manifest versions differ.');
  }
  const enabledPlugins = readCommunityPlugins(paths);
  assertCommunityPlugins(enabledPlugins);
  return { id: build.manifest.id, version: build.manifest.version, sha256: hashes, enabledPlugins };
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedAsScript) {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Usage: node scripts/preflight.mjs (no arguments).');
    }
    const result = runPreflight(getHarnessPaths());
    console.info(`Preflight passed: ${result.id} ${result.version}.`);
    for (const [filename, hash] of Object.entries(result.sha256)) {
      console.info(`${filename}: ${hash} (source = dist = test-vault)`);
    }
    console.info(`Enabled community plugins: ${result.enabledPlugins.join(', ')}.`);
  } catch (error) {
    console.error(`Preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
