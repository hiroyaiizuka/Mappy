import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const pluginId = /^[a-z]+(?:-[a-z]+)*$/u;
// README's known-limitations section, where an item may be limited to a release, e.g.
// 「（0.3.5 まで）」 (harness.md「リリース手順」1). The heading text is load-bearing; README
// marks it with a comment.
const knownLimitationsHeading = /^ {0,3}##[ \t]+既知の制限/u;
const sectionEnd = /^ {0,3}#{1,2}(?:[ \t]|$)/u;
const fenceOpen = /^ {0,3}(`{3,}|~{3,})/u;
const version = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const versionPrefix = String.raw`(?:v|ver\.?[ \t]*)?`;
// 「x.y.z まで」「x.y.z 以前」 and 「〜x.y.z」, allowing a v / Ver. prefix and a soft wrap.
const versionLimits = [
  new RegExp(String.raw`(?<![\d.])${versionPrefix}(${version})(?![\d.])\s*(?:まで|以前)`, 'giu'),
  new RegExp(String.raw`[〜~]\s*${versionPrefix}(${version})(?![\d.])`, 'giu'),
];
// A version written right after a Latin product name (「Obsidian 1.4.0 まで」「iOS 16.0.0 以前」)
// belongs to that product, so it is not compared with Mappy's.
const otherProductBefore = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+-]*)[ \t]+$/u;
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
 * Blank out fenced code blocks (CommonMark: a fence closes on the same character, at least as
 * long, with nothing after it; an unclosed fence runs to the end), keeping the line count.
 */
function blankFencedCode(lines) {
  let fence;
  return lines.map((line) => {
    if (fence) {
      const closing = new RegExp(String.raw`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \t]*$`, 'u');
      if (closing.test(line)) fence = undefined;
      return '';
    }
    const open = line.match(fenceOpen);
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = open[1];
      return '';
    }
    return line;
  });
}

/**
 * Report README known limitations limited to a Mappy release older than `targetVersion`.
 * Only the `## 既知の制限` section is read, outside fenced code and HTML comments, after NFKC
 * (so full-width digits count). A README without the section is reported rather than passing.
 */
export function staleKnownLimitations(readmeText, targetVersion) {
  const lines = blankFencedCode(readmeText.normalize('NFKC').split(/\r?\n/u));
  const start = lines.findIndex((line) => knownLimitationsHeading.test(line));
  if (start < 0) {
    return ['README.md: missing the "## 既知の制限" section, so version-limited known limitations cannot be checked.'];
  }
  let end = lines.findIndex((line, index) => index > start && sectionEnd.test(line));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end).join('\n')
    .replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ''));

  const found = new Map();
  for (const pattern of versionLimits) {
    for (const match of section.matchAll(pattern)) {
      const versionIndex = match.index + match[0].indexOf(match[1]);
      if (found.has(versionIndex)) continue;
      const lineStart = section.lastIndexOf('\n', match.index) + 1;
      const product = section.slice(lineStart, match.index).match(otherProductBefore);
      if (product && product[1].toLowerCase() !== 'mappy') continue;
      found.set(versionIndex, match);
    }
  }
  const errors = [];
  for (const [, match] of [...found].sort(([a], [b]) => a - b)) {
    if (compareVersions(match[1], targetVersion) >= 0) continue;
    const line = start + 2 + (section.slice(0, match.index).match(/\n/gu)?.length ?? 0);
    errors.push(
      `README.md:${line}: known limitation "${match[0].replace(/\s+/gu, ' ')}" is limited to a release older than ${targetVersion}. `
      + `If its fix ships in ${targetVersion}, remove the item; if not, update the version in the item.`,
    );
  }
  return errors;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate source metadata and, optionally, the distributable plugin directory. README's
 * version-limited known limitations are checked unless `knownLimitations` is false: packaging
 * for the test vault must not stop on README prose, and `npm run validate` (first in
 * `npm run check`, and so in release.yml) still runs the check.
 */
export function validateRelease(rootDir, { artifacts = false, knownLimitations = true } = {}) {
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

  let manifestVersionOk = false;
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
    manifestVersionOk = requireVersion(manifest, 'version', 'manifest.json');
    requireVersion(manifest, 'minAppVersion', 'manifest.json');
    if (typeof manifest.isDesktopOnly !== 'boolean') {
      errors.push('manifest.json.isDesktopOnly: expected a boolean.');
    }
  }

  if (knownLimitations && readme && manifestVersionOk) {
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
    // `--artifacts` is the packaging run (`npm run package`); like package-plugin.mjs it leaves
    // README's known limitations to the plain run.
    : validateRelease(process.cwd(), { artifacts: args.includes('--artifacts'), knownLimitations: !args.includes('--artifacts') });

  if (errors.length > 0) {
    for (const error of errors) console.error(`Release validation: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Release ${args.includes('--artifacts') ? 'artifacts' : 'metadata'} validated.`);
  }
}
