import { context } from "esbuild";
import { writeFile } from "node:fs/promises";

const production = process.argv.includes("production");
const build = await context({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
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
    await writeFile("build-meta.json", JSON.stringify(result.metafile, null, 2));
  } finally {
    await build.dispose();
  }
} else {
  await build.watch();
}
