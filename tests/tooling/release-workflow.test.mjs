import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The workflow is not linted by ESLint, so this test is what keeps its shape honest:
// tag-only releases, dry-runs that never get a write token, and the three BRAT assets.
const workflowPath = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url));
const workflow = parse(readFileSync(workflowPath, 'utf8'));
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../manifest.json', import.meta.url)), 'utf8'));
const distributables = ['main.js', 'manifest.json', 'styles.css'].map((name) => `dist/${manifest.id}/${name}`);

/** GitHub's tag filter syntax: `[]` classes, `+` repetition, everything else literal. */
function tagFilterToRegExp(pattern) {
  return new RegExp(`^${pattern.replaceAll('.', '\\.')}$`, 'u');
}

describe('release workflow', () => {
  const triggers = workflow.on;
  const build = workflow.jobs.build;
  const release = workflow.jobs.release;

  it('runs on plain x.y.z tags only, matching manifest.version without a "v" prefix', () => {
    expect(triggers.push).toEqual({ tags: ['[0-9]+.[0-9]+.[0-9]+'] });
    const filter = tagFilterToRegExp(triggers.push.tags[0]);
    expect(filter.test(manifest.version)).toBe(true);
    for (const tag of ['0.1.0', '1.10.2']) expect(filter.test(tag)).toBe(true);
    for (const tag of ['v0.1.0', '0.1', '0.1.0-beta.1', 'release', '0.1.0.1']) expect(filter.test(tag)).toBe(false);
  });

  it('can be dry-run by hand and on pull requests that touch the release tooling', () => {
    expect(triggers).toHaveProperty('workflow_dispatch');
    expect(triggers.pull_request.paths).toEqual(expect.arrayContaining([
      '.github/workflows/release.yml', 'scripts/version-bump.mjs', 'scripts/package-plugin.mjs', 'scripts/validate-release.mjs',
    ]));
  });

  it('gives the build job a read-only token and only the tag-push release job a write token', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(build.permissions).toBeUndefined();
    expect(release.permissions).toEqual({ contents: 'write' });
    expect(release.needs).toBe('build');
    expect(release.if).toContain("github.event_name == 'push'");
    expect(release.if).toContain("github.ref_type == 'tag'");
  });

  it('checks the tag against manifest.version, runs the full check, and uploads exactly the three distributables', () => {
    const runs = build.steps.filter((step) => typeof step.run === 'string').map((step) => step.run);
    const tagCheck = build.steps.find((step) => step.id === 'version');
    expect(tagCheck.run).toContain("require('./manifest.json').version");
    expect(tagCheck.run).toContain('"$GITHUB_REF_TYPE" = "tag"');
    expect(tagCheck.run).toContain('"$GITHUB_REF_NAME" != "$version"');
    expect(tagCheck.run).toContain('exit 1');
    expect(runs).toContain('npm ci');
    expect(runs).toContain('npm run check');
    expect(runs.indexOf('npm run check')).toBeGreaterThan(runs.indexOf(tagCheck.run));

    const upload = build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.with.path.trim().split('\n').map((line) => line.trim())).toEqual(distributables);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with.name).toBe('mappy-${{ steps.version.outputs.version }}');
    expect(build.outputs.version).toBe('${{ steps.version.outputs.version }}');
  });

  it('attaches the same three files from the build artifact to a release named after the tag', () => {
    const download = release.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download.with).toEqual({ name: 'mappy-${{ needs.build.outputs.version }}', path: `dist/${manifest.id}` });
    const create = release.steps.find((step) => typeof step.run === 'string' && step.run.includes('gh release create'));
    expect(create.env).toEqual({ GH_TOKEN: '${{ github.token }}', GH_REPO: '${{ github.repository }}' });
    expect(create.run).toContain('gh release create "$GITHUB_REF_NAME"');
    expect(create.run).toContain('--verify-tag');
    expect(create.run).toContain('--prerelease');
    expect(create.run).not.toContain('--draft');
    for (const file of distributables) expect(create.run).toContain(file);
  });

  it('never expands workflow context inside a shell script', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (typeof step.run === 'string') expect(step.run).not.toContain('${{');
      }
    }
  });
});
