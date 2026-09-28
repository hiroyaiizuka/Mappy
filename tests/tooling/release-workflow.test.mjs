import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The workflow is not linted by ESLint, so this test is what keeps its shape honest:
// tag-only releases, dry-runs that never get a write token, the three BRAT assets, a plain (not
// pre-release) Release for every version, and a build provenance attestation of the same three files.
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
  const attestJob = workflow.jobs.attest;

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

  it('gives the build job a read-only token and write tokens only to the tag-push jobs', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(build.permissions).toBeUndefined();
    expect(release.permissions).toEqual({ contents: 'write' });
    // What actions/attest's README asks for. Only the tag-push attest job has them, and it can't write Releases.
    expect(attestJob.permissions).toEqual({
      contents: 'read', 'id-token': 'write', attestations: 'write', 'artifact-metadata': 'write',
    });
    expect(attestJob.if).toBe(release.if);
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
    // 0.x too is a plain Release (LEV-249): none of the 8,143 directory entries points its manifest version
    // at a pre-release, and BRAT reads plain Releases too. Beta is shown by the 0.x version and the README.
    expect(create.run).not.toContain('prerelease');
    // BRAT can't see a draft (it isn't in the API response for users without push access).
    expect(create.run).not.toContain('--draft');
    for (const file of distributables) expect(create.run).toContain(file);
  });

  it('attests the three released files in a job after the release, with actions/attest pinned to a commit', () => {
    // After the release and in its own job (LEV-249 review): a failed attestation must not stop distribution,
    // and `gh run rerun --failed` re-runs only this job (re-running the release job would fail on the existing
    // Release, and a pushed tag is never reused).
    expect(attestJob.needs).toEqual(['build', 'release']);
    const download = attestJob.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download.with).toEqual({ name: 'mappy-${{ needs.build.outputs.version }}', path: `dist/${manifest.id}` });
    const attestIndex = attestJob.steps.findIndex((step) => step.uses?.startsWith('actions/attest@'));
    expect(attestIndex).toBeGreaterThan(attestJob.steps.indexOf(download));
    const attest = attestJob.steps[attestIndex];
    // The job holds id-token, so the action is a full commit SHA, not a moving tag (v4.2.2 at the time).
    expect(attest.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/u);
    expect(attest.with['subject-path'].trim().split('\n').map((line) => line.trim())).toEqual(distributables);
    // No other job attests: build also runs for pull requests and workflow_dispatch dry-runs.
    for (const job of [build, release]) expect(job.steps.some((step) => step.uses?.startsWith('actions/attest'))).toBe(false);
  });

  it('never expands workflow context inside a shell script', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (typeof step.run === 'string') expect(step.run).not.toContain('${{');
      }
    }
  });
});
