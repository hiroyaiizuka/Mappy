/**
 * Build and serve the Obsidian-free browser harness (docs/harness.md, layer ②).
 *
 *   node scripts/browser-harness.mjs            build once into dist/harness
 *   node scripts/browser-harness.mjs --serve    build, watch and serve on 127.0.0.1
 *   node scripts/browser-harness.mjs --serve --port 8765
 *
 * The same esbuild as the plugin bundles harness/browser/main.ts; the `obsidian`
 * import is aliased to the browser mock and fixture text is embedded via `?raw`.
 */
import { context } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const harnessOutput = join(root, 'dist', 'harness');

/** `import text from "./file.md?raw"` bundles the file's contents as a string. */
const rawLoader = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

function commitHash() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function copyStatic() {
  await mkdir(harnessOutput, { recursive: true });
  await Promise.all([
    copyFile(join(root, 'harness', 'browser', 'index.html'), join(harnessOutput, 'index.html')),
    copyFile(join(root, 'harness', 'browser', 'harness.css'), join(harnessOutput, 'harness.css')),
    copyFile(join(root, 'styles.css'), join(harnessOutput, 'styles.css')),
  ]);
}

function createContext() {
  return context({
    absWorkingDir: root,
    entryPoints: ['harness/browser/main.ts'],
    outfile: 'dist/harness/main.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2021',
    sourcemap: true,
    alias: { obsidian: './harness/browser/obsidian.ts' },
    plugins: [rawLoader],
    define: {
      __MAPPY_HARNESS_BUILD__: JSON.stringify({ commit: commitHash(), builtAt: new Date().toISOString() }),
    },
    logLevel: 'info',
  });
}

/** One-shot build; returns the output directory. */
export async function buildBrowserHarness() {
  await copyStatic();
  const build = await createContext();
  try {
    await build.rebuild();
  } finally {
    await build.dispose();
  }
  return harnessOutput;
}

export async function serveBrowserHarness(port) {
  await copyStatic();
  const build = await createContext();
  await build.watch();
  const served = await build.serve({ servedir: harnessOutput, host: '127.0.0.1', port });
  const url = `http://127.0.0.1:${served.port}/`;
  console.info(`Browser harness: ${url}`);
  console.info('Fixtures switch on the page; ?fixture=<id>&width=<px>&height=<px> preselects one.');
  console.info('Saving, link resolution, themes and IME are not verified here (docs/harness.md).');
  return { url, dispose: () => build.dispose() };
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8765;
  const known = new Set(['--serve', '--port', ...(portIndex >= 0 ? [args[portIndex + 1]] : [])]);
  const unknown = args.filter(argument => !known.has(argument));
  if (unknown.length > 0 || !Number.isInteger(port) || port < 0) {
    console.error('Usage: node scripts/browser-harness.mjs [--serve] [--port <number>]');
    process.exitCode = 1;
  } else if (args.includes('--serve')) {
    await serveBrowserHarness(port);
  } else {
    const output = await buildBrowserHarness();
    console.info(`Built ${output}. Open ${pathToFileURL(join(output, 'index.html')).href}`);
  }
}
