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
  writeFileSync(join(root, 'README.md'), '# Mappy\n');
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
  function readmeErrors(manifestVersion, readme) {
    changeJson('manifest.json', (manifest) => { manifest.version = manifestVersion; });
    writeFileSync(join(root, 'README.md'), readme);
    return validateRelease(root).filter((error) => error.startsWith('README.md'));
  }

  it('rejects an item limited to a version older than the manifest (LEV-209: 0.3.5 left in the 0.3.6 README)', () => {
    const readme = [
      '# Mappy',
      '',
      '## 既知の制限',
      '- **切り替えと同時の保存（0.3.5 まで）**: 拒否されることがあります。',
      '',
    ].join('\n');
    expect(readmeErrors('0.3.6', readme)).toEqual([
      'README.md:4: known limitation "（0.3.5 まで）" is older than manifest.json.version 0.3.6; remove or rewrite it before releasing.',
    ]);
  });

  it('accepts items limited to the current or a later version', () => {
    const readme = '- **a（0.3.6 まで）**: x\n- **b（0.4.0 まで）**: y\n';
    expect(readmeErrors('0.3.6', readme)).toEqual([]);
  });

  it('compares versions numerically, not as strings', () => {
    expect(readmeErrors('0.10.0', '- a（0.9.0 まで）\n')).toHaveLength(1);
    expect(readmeErrors('0.9.0', '- a（0.10.0 まで）\n')).toEqual([]);
    expect(readmeErrors('1.0.0', '- a（0.99.99 まで）\n')).toHaveLength(1);
  });

  it('reports every stale item with its line, including half-width parentheses and spacing variants', () => {
    const readme = '- a (0.3.4 まで)\n- b（0.3.5まで）\n- c（ 0.3.6 まで ）\n- d（0.2.0 まで）と（0.3.0 まで）\n';
    expect(readmeErrors('0.3.6', readme)).toEqual([
      'README.md:1: known limitation "(0.3.4 まで)" is older than manifest.json.version 0.3.6; remove or rewrite it before releasing.',
      'README.md:2: known limitation "（0.3.5まで）" is older than manifest.json.version 0.3.6; remove or rewrite it before releasing.',
      'README.md:4: known limitation "（0.2.0 まで）" is older than manifest.json.version 0.3.6; remove or rewrite it before releasing.',
      'README.md:4: known limitation "（0.3.0 まで）" is older than manifest.json.version 0.3.6; remove or rewrite it before releasing.',
    ]);
  });

  it('skips the comparison when the manifest version is invalid instead of guessing', () => {
    expect(readmeErrors('0.3', '- a（0.1.0 まで）\n')).toEqual([]);
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
