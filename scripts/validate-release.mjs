import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const pluginId = /^[a-z]+(?:-[a-z]+)*$/u;
const atxSectionEnd = /^ {0,3}#{1,2}(?:[ \t]|$)/u;
const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const listItem = /^[ \t]*(?:[-+*]|\d+[.)])(?:[ \t]|$)/u;
const blockquotePrefix = /^[ \t]*(?:>[ \t]?)+/u;
const fenceOpen = /^([ \t]*)(`{3,}|~{3,})(.*)$/u;
// A version written right after a Latin product name (「Obsidian 1.4.0 まで」) belongs to that
// product, so it is not compared with Mappy's.
const otherProductBefore = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+-]*)[ \t]+$/u;
// Words that may stand between "up to" and a Mappy version without naming another product.
const notAProduct = /^(?:mappy|version|ver|v|release)$/iu;

/**
 * Each README's known-limitations section, where an item may be limited to a release
 * (harness.md「リリース手順」1). README.md is English (LEV-227) and README.ja.md its Japanese
 * version; both are checked, since an item removed from one and left in the other would still warn
 * that release's users in one language only. The heading text is load-bearing; each README marks
 * it with a comment. Anything dotted is captured as `version`, so that 「0.3 まで」 or
 * "(up to 0.3.5-beta.1)" is reported instead of silently passing. `otherProduct(match, before)`
 * tells whether the version belongs to another product (`before` is the line up to the match), so
 * that version is not compared with Mappy's.
 */
export const knownLimitationReadmes = [
  {
    file: 'README.md',
    heading: /^ {0,3}##[ \t]+Known limitations/iu,
    headingText: '## Known limitations',
    // "up to x.y.z", allowing up to three words between "to" and the version ("up to version",
    // "up to the", "up to Mappy's", "up to and including"), a v / ver. prefix, soft wraps and a
    // full stop after the version.
    limit: /(?<![A-Za-z])up\s+to\s+(?<words>(?:[A-Za-z][A-Za-z0-9'’.+-]*\s+){0,3}?)(?:v|ver\.?)?(?<version>\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?)(?!\d|\.\d)/giu,
    // The word right before the version names another product when it is capitalized and not
    // Mappy's own ("up to Obsidian 1.4.0"); a lower-case word ("up to the 0.3.5 release") does not.
    otherProduct: (match) => {
      const word = match.groups.words.trim().split(/\s+/u).at(-1)?.replace(/(?:['’]s|\.)$/u, '') ?? '';
      return /^[A-Z]/u.test(word) && !notAProduct.test(word);
    },
    example: '"(up to 0.3.5)"',
  },
  {
    file: 'README.ja.md',
    heading: /^ {0,3}##[ \t]+既知の制限/u,
    headingText: '## 既知の制限',
    // 「x.y.z まで」, allowing a v / Ver. prefix and a soft wrap before まで.
    limit: /(?<![\d.])(?:v|ver\.?[ \t]*)?(?<version>\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?)(?![\d.])\s*まで/giu,
    otherProduct: (match, before) => {
      const word = before.match(otherProductBefore)?.[1];
      return word !== undefined && word.toLowerCase() !== 'mappy';
    },
    example: '「（0.3.5 まで）」',
  },
];
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

const indentOf = (line) => line.match(/^[ \t]*/u)[0].length;

/**
 * Blank out HTML comments and fenced code, keeping the line count. Fences follow CommonMark
 * closely enough for README: they may sit in a blockquote or a list item, close on the same
 * character at least as long, and also end when the list item holding them ends (a non-blank
 * line indented less than the fence) or at the end of the text.
 */
function blankCommentsAndCode(text) {
  const lines = text.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, '')).split('\n');
  let fence;
  return lines.map((line) => {
    const content = line.replace(blockquotePrefix, '');
    if (fence) {
      const closing = content.trim();
      const closes = closing.length >= fence.length && [...closing].every((char) => char === fence.char);
      const leftItem = fence.indent > 0 && content.trim() !== '' && indentOf(content) < fence.indent;
      if (!leftItem) {
        if (closes) fence = undefined;
        return '';
      }
      fence = undefined;
    }
    const open = content.match(fenceOpen);
    if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
      fence = { char: open[2][0], length: open[2].length, indent: open[1].length };
      return '';
    }
    return line;
  });
}

/**
 * Report known limitations in `readme` (one of `knownLimitationReadmes`) limited to a Mappy release
 * older than `targetVersion`, and version limits that are not a full x.y.z (they could never be
 * compared). Only the section under the README's heading is read, outside HTML comments and fenced
 * code, after NFKC (so full-width digits count). A README without the section is reported rather
 * than passing.
 */
export function staleKnownLimitations(readme, readmeText, targetVersion) {
  const { file } = readme;
  const lines = blankCommentsAndCode(readmeText.normalize('NFKC').replace(/\r\n?/gu, '\n'));
  const start = lines.findIndex((line) => readme.heading.test(line));
  if (start < 0) {
    return [`${file}: missing the "${readme.headingText}" section, so version-limited known limitations cannot be checked.`];
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (atxSectionEnd.test(lines[index])) { end = index; break; }
    const previous = lines[index - 1];
    if (index > start + 1 && setextUnderline.test(lines[index]) && previous.trim() !== '' && !listItem.test(previous)) {
      end = index - 1;
      break;
    }
  }
  // Without blockquote markers, so an item wrapped inside a quote reads as one run of text.
  const section = lines.slice(start + 1, end).map((line) => line.replace(blockquotePrefix, '')).join('\n');

  const errors = [];
  for (const match of section.matchAll(readme.limit)) {
    const lineStart = section.lastIndexOf('\n', match.index) + 1;
    if (readme.otherProduct(match, section.slice(lineStart, match.index))) continue;
    const { version } = match.groups;
    const line = start + 2 + (section.slice(0, match.index).match(/\n/gu)?.length ?? 0);
    const item = match[0].replace(/\s+/gu, ' ');
    if (!releaseVersion.test(version)) {
      errors.push(`${file}:${line}: known limitation "${item}" must name a release as x.y.z to be checked, like ${readme.example}.`);
    } else if (compareVersions(version, targetVersion) < 0) {
      errors.push(
        `${file}:${line}: known limitation "${item}" is limited to a release older than ${targetVersion}. `
        + `If its fix ships in ${targetVersion}, remove the item; if not, update the version in the item.`,
      );
    }
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
  // README.md is required in every mode (the community directory shows it); README.ja.md is read
  // only for the known-limitations check, so packaging doesn't stop on it.
  const readmes = knownLimitationReadmes
    .filter((readme) => knownLimitations || readme.file === 'README.md')
    .map((readme) => [readme, readRequired(readme.file)]);

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

  if (knownLimitations && manifestVersionOk) {
    for (const [readme, content] of readmes) {
      if (content) errors.push(...staleKnownLimitations(readme, content.toString('utf8'), manifest.version));
    }
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
