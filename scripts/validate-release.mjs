import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const pluginId = /^[a-z]+(?:-[a-z]+)*$/u;
// README's known-limitations section, where an item may be limited to a release, e.g.
// 「（0.3.5 まで）」 (harness.md「リリース手順」1). Any "x.y.z まで" in the section counts, so
// 「（v0.3.5 まで。0.3.6 で修正）」 and 「Android では 0.3.5 までの版」 are checked too.
const knownLimitationsHeading = '## 既知の制限';
const versionLimit = /(?<![\d.])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?![\d.])\s*まで/gu;
const manifestKeys = new Set([
  'id', 'name', 'version', 'minAppVersion', 'description', 'author',
  'isDesktopOnly', 'authorUrl', 'fundingUrl',
]);

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * Report README known limitations limited to a release older than `version`. Only the
 * `## 既知の制限` section is read (outside code fences), so versions of Obsidian or other
 * tools elsewhere in README are not compared with Mappy's. A README without the section is
 * reported rather than silently passing.
 */
export function staleKnownLimitations(readmeText, version) {
  const lines = readmeText.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === knownLimitationsHeading);
  if (start < 0) {
    return [`README.md: missing the "${knownLimitationsHeading}" section, so version-limited known limitations cannot be checked.`];
  }
  const errors = [];
  let inFence = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,2}\s/u.test(line)) break;
    for (const match of line.matchAll(versionLimit)) {
      if (compareVersions(match[1], version) < 0) {
        errors.push(
          `README.md:${index + 1}: known limitation "${match[0]}" is limited to a release older than ${version}. `
          + `If its fix ships in ${version}, remove the item; if not, update the version in the item.`,
        );
      }
    }
  }
  return errors;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate source metadata and, optionally, the distributable plugin directory. */
export function validateRelease(rootDir, { artifacts = false } = {}) {
  const root = resolve(rootDir);
  const errors = [];

  function readRequired(relativePath) {
    const fullPath = join(root, relativePath);
    try {
      if (!statSync(fullPath).isFile()) {
        errors.push(`${relativePath}: expected a regular file.`);
        return undefined;
      }
      const content = readFileSync(fullPath);
      if (content.toString('utf8').trim().length === 0) {
        errors.push(`${relativePath}: must not be empty.`);
        return undefined;
      }
      return content;
    } catch (error) {
      errors.push(`${relativePath}: ${error.code === 'ENOENT' ? 'file is missing' : 'cannot read file'}.`);
      return undefined;
    }
  }

  function readJson(relativePath) {
    const content = readRequired(relativePath);
    if (content === undefined) return undefined;
    try {
      const value = JSON.parse(content.toString('utf8'));
      if (!isRecord(value)) {
        errors.push(`${relativePath}: expected a JSON object.`);
        return undefined;
      }
      return value;
    } catch {
      errors.push(`${relativePath}: invalid JSON.`);
      return undefined;
    }
  }

  function requireString(object, key, label) {
    if (typeof object[key] !== 'string' || object[key].trim().length === 0) {
      errors.push(`${label}.${key}: expected a non-empty string.`);
      return false;
    }
    return true;
  }

  function requireVersion(object, key, label) {
    if (!requireString(object, key, label)) return false;
    if (!releaseVersion.test(object[key])) {
      errors.push(`${label}.${key}: expected a release version in x.y.z format without leading zeroes.`);
      return false;
    }
    return true;
  }

  function requireMatch(actual, expected, label, expectedLabel) {
    if (actual !== expected) {
      errors.push(`${label}: must match ${expectedLabel}.`);
    }
  }

  const manifest = readJson('manifest.json');
  const packageJson = readJson('package.json');
  const versions = readJson('versions.json');
  const lockfile = readJson('package-lock.json');
  readRequired('LICENSE');
  const readme = readRequired('README.md');

  if (manifest) {
    // Official schema: https://docs.obsidian.md/Reference/Manifest
    for (const key of Object.keys(manifest)) {
      if (!manifestKeys.has(key)) errors.push(`manifest.json.${key}: unknown manifest property.`);
    }
    for (const key of ['id', 'name', 'description', 'author']) {
      requireString(manifest, key, 'manifest.json');
    }
    if (typeof manifest.id === 'string' && !pluginId.test(manifest.id)) {
      errors.push('manifest.json.id: expected a safe plugin ID containing only lowercase letters and hyphens.');
    }
    if (typeof manifest.id === 'string' && /obsidian|plugin$/iu.test(manifest.id)) {
      errors.push('manifest.json.id: must not contain "obsidian" or end with "plugin".');
    }
    if (typeof manifest.name === 'string' && /obsidian|plugin|obsi-|-sidian/iu.test(manifest.name)) {
      errors.push('manifest.json.name: must not contain "Obsidian", "Plugin", or Obsidian name variations.');
    }
    if (typeof manifest.name === 'string' && !/^[A-Za-z0-9 ()+-]+$/u.test(manifest.name)) {
      errors.push('manifest.json.name: use Basic Latin letters, numbers, spaces, hyphens, plus signs, or parentheses.');
    }
    if ('authorUrl' in manifest) requireString(manifest, 'authorUrl', 'manifest.json');
    if ('fundingUrl' in manifest) {
      if (isRecord(manifest.fundingUrl)) {
        const values = Object.values(manifest.fundingUrl);
        if (values.length === 0 || values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
          errors.push('manifest.json.fundingUrl: expected a non-empty object of non-empty URL strings.');
        }
      } else {
        requireString(manifest, 'fundingUrl', 'manifest.json');
      }
    }
    requireVersion(manifest, 'version', 'manifest.json');
    requireVersion(manifest, 'minAppVersion', 'manifest.json');
    if (typeof manifest.isDesktopOnly !== 'boolean') {
      errors.push('manifest.json.isDesktopOnly: expected a boolean.');
    }
  }

  if (readme && manifest && typeof manifest.version === 'string' && releaseVersion.test(manifest.version)) {
    errors.push(...staleKnownLimitations(readme.toString('utf8'), manifest.version));
  }

  if (packageJson) {
    requireString(packageJson, 'name', 'package.json');
    requireVersion(packageJson, 'version', 'package.json');
    if (manifest) {
      requireMatch(packageJson.version, manifest.version, 'package.json.version', 'manifest.json.version');
    }
  }

  if (versions) {
    for (const [version, minimumAppVersion] of Object.entries(versions)) {
      if (!releaseVersion.test(version)) {
        errors.push(`versions.json[${JSON.stringify(version)}]: key must be a release version in x.y.z format.`);
      }
      if (typeof minimumAppVersion !== 'string' || !releaseVersion.test(minimumAppVersion)) {
        errors.push(`versions.json[${JSON.stringify(version)}]: value must be a minimum app version in x.y.z format.`);
      }
    }
    if (manifest && typeof manifest.version === 'string') {
      requireMatch(
        versions[manifest.version], manifest.minAppVersion,
        `versions.json[${JSON.stringify(manifest.version)}]`, 'manifest.json.minAppVersion',
      );
    }
  }

  if (lockfile) {
    requireString(lockfile, 'name', 'package-lock.json');
    requireVersion(lockfile, 'version', 'package-lock.json');
    if (!Number.isInteger(lockfile.lockfileVersion) || lockfile.lockfileVersion < 1) {
      errors.push('package-lock.json.lockfileVersion: expected a positive integer.');
    }
    if (packageJson) {
      requireMatch(lockfile.name, packageJson.name, 'package-lock.json.name', 'package.json.name');
      requireMatch(lockfile.version, packageJson.version, 'package-lock.json.version', 'package.json.version');
    }
    if (lockfile.lockfileVersion >= 2) {
      const lockRoot = isRecord(lockfile.packages) ? lockfile.packages[''] : undefined;
      if (!isRecord(lockRoot)) {
        errors.push('package-lock.json.packages[""]: expected root package metadata.');
      } else {
        requireString(lockRoot, 'name', 'package-lock.json.packages[""]');
        requireVersion(lockRoot, 'version', 'package-lock.json.packages[""]');
        if (packageJson) {
          requireMatch(lockRoot.name, packageJson.name, 'package-lock.json.packages[""].name', 'package.json.name');
          requireMatch(lockRoot.version, packageJson.version, 'package-lock.json.packages[""].version', 'package.json.version');
        }
      }
    }
  }

  if (artifacts && manifest && typeof manifest.id === 'string' && pluginId.test(manifest.id)) {
    for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
      const relativePath = join('dist', manifest.id, filename);
      const source = readRequired(filename);
      const distribution = readRequired(relativePath);
      if (source && distribution && !source.equals(distribution)) {
        errors.push(`${relativePath}: contents must match the root ${filename}.`);
      }
    }
  }

  return errors;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedAsScript) {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((argument) => argument !== '--artifacts');
  const errors = unknownArgs.length > 0
    ? [`Unknown arguments: ${unknownArgs.join(', ')}. Usage: node scripts/validate-release.mjs [--artifacts]`]
    : validateRelease(process.cwd(), { artifacts: args.includes('--artifacts') });

  if (errors.length > 0) {
    for (const error of errors) console.error(`Release validation: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Release ${args.includes('--artifacts') ? 'artifacts' : 'metadata'} validated.`);
  }
}
