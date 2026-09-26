import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateRelease } from '../../scripts/validate-release.mjs';

const cliPath = fileURLToPath(new URL('../../scripts/validate-release.mjs', import.meta.url));
let root;

function writeJson(filename, value) {
  writeFileSync(join(root, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function changeJson(filename, update) {
  const value = JSON.parse(readFileSync(join(root, filename), 'utf8'));
  update(value);
  writeJson(filename, value);
}

function addArtifacts() {
  const directory = join(root, 'dist', 'mappy');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, 'main.js'), 'module.exports = {};\n');
  writeFileSync(join(root, 'styles.css'), '.mappy { color: var(--text-normal); }\n');
  for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
    writeFileSync(join(directory, filename), readFileSync(join(root, filename)));
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mappy-release-test-'));
  writeJson('package.json', { name: 'mappy-dev', version: '0.1.0' });
  writeJson('manifest.json', {
    id: 'mappy', name: 'Mappy', version: '0.1.0', minAppVersion: '1.6.7',
    description: 'Edit notes as mind maps.', author: 'Example author', isDesktopOnly: false,
  });
  writeJson('versions.json', { '0.1.0': '1.6.7' });
  writeJson('package-lock.json', {
    name: 'mappy-dev', version: '0.1.0', lockfileVersion: 3,
    packages: { '': { name: 'mappy-dev', version: '0.1.0' } },
  });
  writeFileSync(join(root, 'LICENSE'), 'Test license\n');
  writeFileSync(join(root, 'README.md'), '# Mappy\n\n## 既知の制限\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('release metadata validation', () => {
  it('accepts aligned metadata without requiring build outputs or package name equal to plugin ID', () => {
    expect(validateRelease(root)).toEqual([]);
  });

  it('reports independent malformed fields together', () => {
    changeJson('manifest.json', (manifest) => {
      manifest.name = ' ';
      manifest.author = null;
      manifest.description = 42;
      manifest.isDesktopOnly = 'false';
      manifest.version = '01.0.0';
      manifest.minAppVersion = '1.6.7-beta';
    });
    const errors = validateRelease(root).join('\n');
    for (const field of ['name', 'author', 'description', 'isDesktopOnly', 'version', 'minAppVersion']) {
      expect(errors).toContain(`manifest.json.${field}:`);
    }
  });

  it.each(['../other', 'a/b', 'a\\b', '/tmp/mappy', '..', '', 'mappy2'])('rejects unsafe or invalid plugin ID %j', (id) => {
    changeJson('manifest.json', (manifest) => { manifest.id = id; });
    const errors = validateRelease(root, { artifacts: true });
    expect(errors.some((error) => error.startsWith('manifest.json.id:'))).toBe(true);
    expect(errors.some((error) => error.startsWith('dist'))).toBe(false);
  });

  it.each(['obsidian-mappy', 'mappy-plugin'])('rejects official forbidden plugin ID %j', (id) => {
    changeJson('manifest.json', (manifest) => { manifest.id = id; });
    expect(validateRelease(root)).toContain('manifest.json.id: must not contain "obsidian" or end with "plugin".');
  });

  it.each(['Obsidian Mappy', 'Mappy Plugin', 'Obsi-Mappy', 'Map-sidian'])('rejects official forbidden plugin name %j', (name) => {
    changeJson('manifest.json', (manifest) => { manifest.name = name; });
    expect(validateRelease(root).join('\n')).toContain('manifest.json.name: must not contain');
  });

  it('rejects unsupported manifest keys and incorrectly typed optional metadata', () => {
    changeJson('manifest.json', (manifest) => {
      manifest.minimumAppVersion = '1.6.7';
      manifest.authorUrl = 42;
      manifest.fundingUrl = { Sponsor: false };
      manifest.name = 'Mappy!';
    });
    const errors = validateRelease(root).join('\n');
    expect(errors).toContain('manifest.json.minimumAppVersion: unknown manifest property');
    expect(errors).toContain('manifest.json.authorUrl: expected a non-empty string');
    expect(errors).toContain('manifest.json.fundingUrl: expected a non-empty object');
    expect(errors).toContain('manifest.json.name: use Basic Latin');
  });

  it.each(['https://example.com/sponsor', { Sponsor: 'https://example.com/sponsor' }])('accepts documented optional funding metadata %j', (fundingUrl) => {
    changeJson('manifest.json', (manifest) => {
      manifest.authorUrl = 'https://example.com';
      manifest.fundingUrl = fundingUrl;
    });
    expect(validateRelease(root)).toEqual([]);
  });

  it('detects stale package, lockfile, and compatibility versions', () => {
    changeJson('package.json', (value) => { value.version = '0.2.0'; });
    changeJson('package-lock.json', (value) => {
      value.name = 'wrong-package';
      value.packages[''].version = '0.3.0';
    });
    writeJson('versions.json', { '0.1.0': '1.5.0' });
    const errors = validateRelease(root).join('\n');
    expect(errors).toContain('package.json.version: must match manifest.json.version');
    expect(errors).toContain('package-lock.json.name: must match package.json.name');
    expect(errors).toContain('package-lock.json.version: must match package.json.version');
    expect(errors).toContain('package-lock.json.packages[""].version: must match package.json.version');
    expect(errors).toContain('versions.json["0.1.0"]: must match manifest.json.minAppVersion');
  });

  it('requires the current compatibility entry and rejects malformed historical entries', () => {
    writeJson('versions.json', { 'v0.0.1': 123 });
    const errors = validateRelease(root).join('\n');
    expect(errors).toContain('key must be a release version');
    expect(errors).toContain('value must be a minimum app version');
    expect(errors).toContain('versions.json["0.1.0"]: must match');
  });

  it('requires root package metadata in modern lockfiles', () => {
    changeJson('package-lock.json', (value) => { delete value.packages['']; });
    expect(validateRelease(root)).toContain('package-lock.json.packages[""]: expected root package metadata.');
  });

  it('aggregates invalid JSON, missing documentation, and empty licenses', () => {
    writeFileSync(join(root, 'manifest.json'), '{ broken');
    writeJson('versions.json', []);
    rmSync(join(root, 'README.md'));
    writeFileSync(join(root, 'LICENSE'), ' \n');
    expect(validateRelease(root)).toEqual(expect.arrayContaining([
      'manifest.json: invalid JSON.',
      'versions.json: expected a JSON object.',
      'LICENSE: must not be empty.',
      'README.md: file is missing.',
    ]));
  });
});

describe('README version-limited known limitations', () => {
  const stale = (line, item, version) => `README.md:${line}: known limitation "${item}" is limited to a release older than ${version}. `
    + `If its fix ships in ${version}, remove the item; if not, update the version in the item.`;

  function readmeErrors(manifestVersion, limitations, { before = '', after = '' } = {}) {
    changeJson('manifest.json', (manifest) => { manifest.version = manifestVersion; });
    writeFileSync(join(root, 'README.md'), `# Mappy\n${before}\n## 既知の制限\n\n${limitations}\n${after}`);
    return validateRelease(root).filter((error) => error.startsWith('README.md'));
  }

  // With an empty `before`, the heading is line 3 of the README written above, so the first
  // limitation is on line 5.
  it('rejects an item limited to a version older than the manifest (LEV-209: 0.3.5 left in the 0.3.6 README)', () => {
    expect(readmeErrors('0.3.6', '- **切り替えと同時の保存（0.3.5 まで）**: 拒否されることがあります。')).toEqual([
      stale(5, '0.3.5 まで', '0.3.6'),
    ]);
  });

  it('accepts items limited to the current or a later version', () => {
    expect(readmeErrors('0.3.6', '- **a（0.3.6 まで）**: x\n- **b（0.4.0 まで）**: y')).toEqual([]);
  });

  it('compares versions numerically, not as strings', () => {
    expect(readmeErrors('0.10.0', '- a（0.9.0 まで）')).toHaveLength(1);
    expect(readmeErrors('0.9.0', '- a（0.10.0 まで）')).toEqual([]);
    expect(readmeErrors('1.0.0', '- a（0.99.99 まで）')).toHaveLength(1);
  });

  it('reports every stale item with its line, whatever the parentheses, spacing, prefix, or surrounding wording', () => {
    const limitations = [
      '- a (0.3.4 まで)',
      '- b（0.3.5まで）',
      '- c（ 0.3.6 まで ）',
      '- d（0.2.0 まで）と（0.3.0 まで）',
      '- e（v0.3.1 まで。0.3.2 で修正）',
      '- f（Android では 0.3.2 まで）',
      '- g: 0.3.3 までの版では起きます。',
    ].join('\n');
    expect(readmeErrors('0.3.6', limitations)).toEqual([
      stale(5, '0.3.4 まで', '0.3.6'),
      stale(6, '0.3.5まで', '0.3.6'),
      stale(8, '0.2.0 まで', '0.3.6'),
      stale(8, '0.3.0 まで', '0.3.6'),
      stale(9, 'v0.3.1 まで', '0.3.6'),
      stale(10, '0.3.2 まで', '0.3.6'),
      stale(11, '0.3.3 まで', '0.3.6'),
    ]);
  });

  it('reads only the known-limitations section, outside code fences, so other tools\' versions are not compared', () => {
    const errors = readmeErrors('2.0.0', '- Mappy（1.0.0 まで）\n\n```\nObsidian（1.4.16 まで）\n```\n\n### 詳細\n- BRAT（1.0.6 まで）', {
      before: '\n## 対応環境\n\nObsidian（1.4.16 まで）では動きません。\n',
      after: '\n## 困ったとき\n\n旧版（1.0.0 まで）の復旧\n',
    });
    expect(errors).toEqual([stale(9, '1.0.0 まで', '2.0.0'), stale(16, '1.0.6 まで', '2.0.0')]);
  });

  it('reports a README without the known-limitations section instead of silently passing', () => {
    writeFileSync(join(root, 'README.md'), '# Mappy\n\n## 制限\n\n- a（0.0.1 まで）\n');
    expect(validateRelease(root)).toEqual([
      'README.md: missing the "## 既知の制限" section, so version-limited known limitations cannot be checked.',
    ]);
  });

  it('detects Ver. prefixes, 以前, a leading 〜, full-width digits, and an item wrapped across lines', () => {
    const limitations = [
      '- a（Ver.0.3.1 まで）',
      '- b（0.3.2 以前）',
      '- c（〜0.3.3）',
      '- d（０.３.４ まで）',
      '- e: 長い説明で 0.3.5',
      '  まで起きます。',
    ].join('\n');
    expect(readmeErrors('0.3.6', limitations)).toEqual([
      stale(5, 'Ver.0.3.1 まで', '0.3.6'),
      stale(6, '0.3.2 以前', '0.3.6'),
      stale(7, '〜0.3.3', '0.3.6'),
      stale(8, '0.3.4 まで', '0.3.6'),
      stale(9, '0.3.5 まで', '0.3.6'),
    ]);
  });

  it('does not compare a version written right after another product\'s name, or inside an HTML comment', () => {
    const limitations = [
      '- Obsidian 1.4.0 までは設定が別の場所にあります。',
      '- iOS 16.0.0 以前では動きません。',
      '<!-- 下書き（0.1.0 まで）',
      '-->',
      '- Mappy 0.3.5 までの切り替え',
    ].join('\n');
    expect(readmeErrors('2.0.0', limitations)).toEqual([stale(9, '0.3.5 まで', '2.0.0')]);
  });

  it('pairs fences by character and length, so a ``` inside a ~~~ block does not hide later items', () => {
    const limitations = [
      '~~~',
      '```',
      '- 例（0.1.0 まで）',
      '~~~',
      '- a（0.3.5 まで）',
      '````',
      '```',
      '## 見出しではない',
      '````',
      '- b（0.3.4 まで）',
    ].join('\n');
    expect(readmeErrors('0.3.6', limitations)).toEqual([
      stale(9, '0.3.5 まで', '0.3.6'), stale(14, '0.3.4 まで', '0.3.6'),
    ]);
  });

  it('accepts a reworded heading that still starts with 既知の制限, and ignores the heading inside a fence', () => {
    writeFileSync(join(root, 'README.md'), '# Mappy\n\n```\n## 既知の制限\n```\n\n## 既知の制限と注意\n\n- a（0.0.1 まで）\n');
    expect(validateRelease(root)).toEqual([stale(9, '0.0.1 まで', '0.1.0')]);
  });

  it('leaves README to the plain run when packaging, so a stale item does not block the test vault build', () => {
    writeFileSync(join(root, 'README.md'), '# Mappy\n\n## 既知の制限\n\n- a（0.0.1 まで）\n');
    expect(validateRelease(root, { knownLimitations: false })).toEqual([]);
    addArtifacts();
    const packaging = spawnSync(process.execPath, [cliPath, '--artifacts'], { cwd: root, encoding: 'utf8' });
    expect(packaging.status).toBe(0);
    const plain = spawnSync(process.execPath, [cliPath], { cwd: root, encoding: 'utf8' });
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain('README.md:5: known limitation "0.0.1 まで"');
  });

  it('skips the comparison when the manifest version is invalid instead of guessing', () => {
    expect(readmeErrors('0.3', '- a（0.1.0 まで）')).toEqual([]);
  });
});

describe('distribution artifact validation', () => {
  it('accepts nonempty artifacts matching their root files', () => {
    addArtifacts();
    expect(validateRelease(root, { artifacts: true })).toEqual([]);
  });

  it('detects stale JavaScript, manifest, and stylesheet independently', () => {
    addArtifacts();
    for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
      writeFileSync(join(root, 'dist', 'mappy', filename), 'stale\n');
    }
    const errors = validateRelease(root, { artifacts: true });
    expect(errors).toHaveLength(3);
    for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
      expect(errors).toContain(`dist/mappy/${filename}: contents must match the root ${filename}.`);
    }
  });

  it('rejects missing and empty distribution artifacts', () => {
    addArtifacts();
    rmSync(join(root, 'dist', 'mappy', 'main.js'));
    writeFileSync(join(root, 'dist', 'mappy', 'styles.css'), '\n');
    expect(validateRelease(root, { artifacts: true })).toEqual(expect.arrayContaining([
      'dist/mappy/main.js: file is missing.',
      'dist/mappy/styles.css: must not be empty.',
    ]));
  });
});

describe('validation CLI', () => {
  it('checks the caller working directory and exits nonzero with aggregated failures', () => {
    rmSync(join(root, 'LICENSE'));
    rmSync(join(root, 'README.md'));
    const result = spawnSync(process.execPath, [cliPath], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('LICENSE: file is missing');
    expect(result.stderr).toContain('README.md: file is missing');
  });

  it('honors --artifacts and rejects unknown options instead of silently skipping a check', () => {
    const missingArtifacts = spawnSync(process.execPath, [cliPath, '--artifacts'], { cwd: root, encoding: 'utf8' });
    expect(missingArtifacts.status).toBe(1);
    expect(missingArtifacts.stderr).toContain('dist/mappy/main.js: file is missing');

    const unknownOption = spawnSync(process.execPath, [cliPath, '--artifact'], { cwd: root, encoding: 'utf8' });
    expect(unknownOption.status).toBe(1);
    expect(unknownOption.stderr).toContain('Unknown arguments: --artifact');
  });
});
