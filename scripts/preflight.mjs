import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devUnlockErrors } from './validate-release.mjs';

export const pluginFiles = ['main.js', 'manifest.json', 'styles.css'];
export const markerContents = 'Mappy generated test vault v1\n';
/**
 * The builds a generated vault can hold, named in its `.mappy-harness-build`: `release` (`npm run harness:prepare`,
 * the packaged dist/mappy) and `ai-dev` (`npm run harness:prepare:ai-dev`, dist/mappy-ai-dev with the AI
 * development unlock, docs/architecture.md §11.6). A vault without the file predates it and holds `release`.
 */
export const harnessBuilds = ['release', 'ai-dev'];
/** Community plugins a generated vault may enable: mappy, and Excalidraw for the M6 cases (E23–E27, E30, E33). */
export const allowedCommunityPlugins = ['mappy', 'obsidian-excalidraw-plugin'];

export function harnessPaths(root) {
  const vault = join(root, 'test-vault');
  return {
    root,
    vault,
    marker: join(vault, '.mappy-generated'),
    distribution: join(root, 'dist', 'mappy'),
    devDistribution: join(root, 'dist', 'mappy-ai-dev'),
    buildMark: join(vault, '.mappy-harness-build'),
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

function assertHarnessBuild(build) {
  if (!harnessBuilds.includes(build)) {
    throw new Error(`Unknown harness build "${build}"; expected ${harnessBuilds.join(' or ')}.`);
  }
}

/** The build the generated vault was prepared with (its `.mappy-harness-build`). */
export function readInstalledBuild(paths) {
  if (!assertSafePath(paths.root, paths.buildMark, 'file', { optional: true })) return 'release';
  const build = readFileSync(paths.buildMark).toString('utf8').trim();
  assertHarnessBuild(build);
  return build;
}

/**
 * Verify a packaged build before preparing or checking a generated vault. `release`: the root files and dist/mappy
 * are the same bytes (`npm run package`). `ai-dev`: dist/mappy-ai-dev has the root manifest and styles, and its
 * main.js carries the development unlock (the inverse of `validate-release --artifacts`); the root main.js is the
 * release build, so it is not compared.
 */
export function readHarnessBuild(paths, build = 'release') {
  assertHarnessBuild(build);
  const files = new Map();
  const directory = build === 'release' ? paths.distribution : paths.devDistribution;
  const label = build === 'release' ? 'dist/mappy' : 'dist/mappy-ai-dev';
  for (const filename of pluginFiles) {
    const distribution = readSafeFile(paths.root, join(directory, filename));
    if (build === 'release' || filename !== 'main.js') {
      const source = readSafeFile(paths.root, join(paths.root, filename));
      if (sha256(source) !== sha256(distribution)) {
        throw new Error(`${filename}: source and ${label} differ; run ${build === 'release' ? 'npm run package' : 'npm run harness:prepare:ai-dev'}.`);
      }
    }
    files.set(filename, distribution);
  }
  if (build === 'ai-dev') {
    const errors = devUnlockErrors(files.get('main.js').toString('utf8'), `${label}/main.js`, { expected: true });
    if (errors.length > 0) throw new Error(errors[0]);
  }
  const manifest = parseManifest(files.get('manifest.json'), `${label}/manifest.json`);
  return { files, manifest };
}

/**
 * `build`: the build the caller needs (a case of the AI development unlock asks for `ai-dev`). A vault holding the
 * other one is refused, so a case never runs on a build it was not written for.
 */
export function runPreflight(paths, { build: expected = 'release' } = {}) {
  assertGeneratedVault(paths);
  assertHarnessBuild(expected);
  const installedBuild = readInstalledBuild(paths);
  if (installedBuild !== expected) {
    throw new Error(`test-vault holds the ${installedBuild} build, not ${expected}; run npm run ${expected === 'release' ? 'harness:prepare' : 'harness:prepare:ai-dev'}.`);
  }
  const build = readHarnessBuild(paths, expected);
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
  return { id: build.manifest.id, version: build.manifest.version, build: expected, sha256: hashes, enabledPlugins };
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedAsScript) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--ai-dev')) {
      throw new Error('Usage: node scripts/preflight.mjs [--ai-dev].');
    }
    const result = runPreflight(getHarnessPaths(), { build: args[0] === '--ai-dev' ? 'ai-dev' : 'release' });
    console.info(`Preflight passed: ${result.id} ${result.version}${result.build === 'release' ? '' : ` (${result.build})`}.`);
    for (const [filename, hash] of Object.entries(result.sha256)) {
      console.info(`${filename}: ${hash} (${result.build === 'release' ? 'source = dist' : 'dist/mappy-ai-dev'} = test-vault)`);
    }
    console.info(`Enabled community plugins: ${result.enabledPlugins.join(', ')}.`);
  } catch (error) {
    console.error(`Preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
