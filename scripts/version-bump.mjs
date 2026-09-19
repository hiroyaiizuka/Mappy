import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Same rule as validate-release.mjs: a release version is x.y.z without a "v" prefix.
const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function readJsonObject(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label}: ${error.code === 'ENOENT' ? 'file is missing' : 'invalid JSON'}.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected a JSON object.`);
  }
  return value;
}

/**
 * Point manifest.json at `version` and record `version: minAppVersion` in versions.json.
 * package.json and package-lock.json are npm's job (`npm version <x.y.z>` runs this as its
 * `version` script); `npm run validate` catches any drift between the four files afterwards.
 * Mirrors the official sample plugin's version-bump.mjs, with the repository's 2-space JSON.
 */
export function bumpVersion(rootDir, version) {
  if (typeof version !== 'string' || !releaseVersion.test(version)) {
    throw new Error(`expected a release version in x.y.z format without a "v" prefix, got ${JSON.stringify(version)}.`);
  }
  const root = resolve(rootDir);
  const manifestPath = join(root, 'manifest.json');
  const versionsPath = join(root, 'versions.json');
  const manifest = readJsonObject(manifestPath, 'manifest.json');
  const versions = readJsonObject(versionsPath, 'versions.json');
  if (typeof manifest.minAppVersion !== 'string' || !releaseVersion.test(manifest.minAppVersion)) {
    throw new Error('manifest.json.minAppVersion: expected a version in x.y.z format.');
  }
  manifest.version = version;
  versions[version] = manifest.minAppVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
  return { version, minAppVersion: manifest.minAppVersion };
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedAsScript) {
  // `npm version x.y.z` passes the new version through the environment after it has
  // updated package.json and package-lock.json. An explicit argument wins for manual runs.
  const version = process.argv[2] ?? process.env.npm_package_version;
  try {
    const result = bumpVersion(process.cwd(), version);
    console.log(`manifest.json and versions.json now declare ${result.version} (minAppVersion ${result.minAppVersion}).`);
  } catch (error) {
    console.error(`Version bump: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
