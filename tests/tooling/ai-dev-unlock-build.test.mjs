import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { devUnlockErrors, devUnlockMarker } from '../../scripts/validate-release.mjs';

/**
 * The AI development unlock (docs/architecture.md §11.6, LEV-273) through the real esbuild.config.mjs, both ways:
 * the production build that `npm run package` and release.yml ship has no trace of it, and only
 * `MAPPY_AI_DEV_UNLOCK=1` builds it, into dist/mappy-ai-dev and never over the root main.js. The source is copied
 * to a temporary root so the project's own main.js and dist/ are left alone.
 */
const project = fileURLToPath(new URL('../../', import.meta.url));
let root;

function build(env) {
  const result = spawnSync(process.execPath, ['esbuild.config.mjs', 'production'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, MAPPY_AI_DEV_UNLOCK: '', ...env },
  });
  expect(result.status, result.stderr).toBe(0);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mappy-ai-dev-build-'));
  cpSync(join(project, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(project, 'esbuild.config.mjs'), join(root, 'esbuild.config.mjs'));
  cpSync(join(project, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the AI development unlock in the bundle', () => {
  it('is absent from the build without MAPPY_AI_DEV_UNLOCK, which validate-release --artifacts passes', () => {
    build({});
    const bundle = readFileSync(join(root, 'main.js'), 'utf8');
    expect(bundle).not.toContain(devUnlockMarker);
    expect(devUnlockErrors(bundle, 'main.js')).toEqual([]);
    expect(existsSync(join(root, 'dist', 'mappy-ai-dev'))).toBe(false);
  }, 60_000);

  it('is present only with MAPPY_AI_DEV_UNLOCK=1, in dist/mappy-ai-dev, leaving the root main.js as it was', () => {
    build({});
    const release = readFileSync(join(root, 'main.js'));
    build({ MAPPY_AI_DEV_UNLOCK: '1' });
    expect(readFileSync(join(root, 'main.js')).equals(release)).toBe(true);
    const bundle = readFileSync(join(root, 'dist', 'mappy-ai-dev', 'main.js'), 'utf8');
    expect(bundle).toContain(devUnlockMarker);
    expect(devUnlockErrors(bundle, 'dist/mappy-ai-dev/main.js')).toHaveLength(1);
    expect(devUnlockErrors(bundle, 'dist/mappy-ai-dev/main.js', { expected: true })).toEqual([]);
    expect(existsSync(join(root, 'dist', 'mappy-ai-dev', 'build-meta.json'))).toBe(true);
  }, 60_000);

  it('the marker the check looks for is the one the unlock carries', () => {
    const source = readFileSync(join(project, 'src', 'ai', 'license', 'dev-unlock.ts'), 'utf8');
    expect(source).toContain(`DEV_UNLOCK_MARKER = '${devUnlockMarker}'`);
  });
});
