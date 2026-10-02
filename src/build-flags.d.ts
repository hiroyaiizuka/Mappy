/**
 * Set by esbuild's `define` when the bundle is built (esbuild.config.mjs) and by vitest.config.mts in the tests.
 * `true` only for `MAPPY_AI_DEV_UNLOCK=1`, whose bundle goes to dist/mappy-ai-dev and never to a release
 * (docs/architecture.md §11.6「開発用の解放」). Read it where it is used, so the dead branch is dropped from the
 * release bundle.
 */
declare const MAPPY_AI_DEV_UNLOCK: boolean;
