import { context } from "esbuild";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const production = process.argv.includes("production");
// The development unlock of the AI license (docs/architecture.md §11.6): only `MAPPY_AI_DEV_UNLOCK=1` turns it on,
// and that bundle goes to dist/mappy-ai-dev, never to the root main.js that `npm run package` and releases ship.
// Every other build defines the flag as `false`, so the unlock's code is dropped from the bundle.
const devUnlock = process.env.MAPPY_AI_DEV_UNLOCK === "1";
const outdir = devUnlock ? "dist/mappy-ai-dev" : ".";
const build = await context({
  entryPoints: ["src/main.ts"],
  outfile: join(outdir, "main.js"),
  define: { MAPPY_AI_DEV_UNLOCK: devUnlock ? "true" : "false" },
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2021",
  external: [
    "obsidian",
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
    "@codemirror/language", "@codemirror/lint", "@codemirror/search",
    "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
  ],
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  metafile: true,
  logLevel: "info",
});

if (production) {
  try {
    const result = await build.rebuild();
    await writeFile(join(outdir, "build-meta.json"), JSON.stringify(result.metafile, null, 2));
  } finally {
    await build.dispose();
  }
} else {
  await build.watch();
}
