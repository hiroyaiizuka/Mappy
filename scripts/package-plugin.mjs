import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateRelease } from "./validate-release.mjs";

const errors = validateRelease(process.cwd());
if (errors.length > 0) throw new Error(errors.join("\n"));

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
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
