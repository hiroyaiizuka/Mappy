import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { devUnlockErrors, validateRelease } from "./validate-release.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--ai-dev")) {
  throw new Error("Usage: node scripts/package-plugin.mjs [--ai-dev]");
}

// README's known limitations are checked by `npm run validate`, not when packaging for the test vault.
const errors = validateRelease(process.cwd(), { knownLimitations: false });
if (errors.length > 0) throw new Error(errors.join("\n"));

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));

if (args[0] === "--ai-dev") {
  // The AI development unlock (docs/architecture.md §11.6): `MAPPY_AI_DEV_UNLOCK=1` built dist/mappy-ai-dev/main.js;
  // this puts the root manifest and styles beside it, and leaves dist/mappy and the release build alone.
  const target = join("dist", "mappy-ai-dev");
  const unlockErrors = devUnlockErrors(await readFile(join(target, "main.js"), "utf8"), `${target}/main.js`, { expected: true });
  if (unlockErrors.length > 0) throw new Error(unlockErrors.join("\n"));
  for (const name of ["manifest.json", "styles.css"]) await copyFile(name, join(target, name));
  // Ties this bundle to the root main.js built from the same sources just before (npm run harness:prepare:ai-dev runs
  // npm run check first); preflight refuses the pair once the root build changes without this one.
  await writeFile(join(target, "build-info.json"), JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    releaseMainSha256: createHash("sha256").update(await readFile("main.js")).digest("hex"),
  }, null, 2) + "\n");
  console.info(`Packaged ${target} (AI development unlock; never released)`);
} else {
  const target = join("dist", manifest.id);
  await mkdir(target, { recursive: true });
  const sha256 = {};
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(name, join(target, name));
    sha256[name] = createHash("sha256").update(await readFile(name)).digest("hex");
  }
  await writeFile("dist/build-info.json", JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    sha256,
  }, null, 2) + "\n");
  console.info(`Packaged ${target}`);
}
