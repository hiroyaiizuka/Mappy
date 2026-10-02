import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One hash over the files a bundle was built from: esbuild's metafile `inputs` (paths relative to `root`), each path
 * with its bytes, in path order. esbuild.config.mjs writes it beside the AI development bundle (dist/mappy-ai-dev),
 * and preflight recomputes it from the files on disk, so a bundle left from earlier sources is refused
 * (docs/architecture.md §11.6「開発用の解放」, LEV-273).
 */
export function sourcesSha256(root, inputs) {
  const hash = createHash('sha256');
  for (const path of Object.keys(inputs).sort()) {
    hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  }
  return hash.digest('hex');
}
