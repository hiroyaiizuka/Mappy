import { normalizePath, type App, type TFile } from 'obsidian';

const UNTITLED = '無題のマインドマップ';

/** New maps use the canonical marker and the H2 + bullet-list document shape. */
export function newMindmapSource(title: string): string {
  return `---\nmappy: true\n---\n\n## ${title}\n`;
}

function childPath(folder: string, name: string): string {
  return normalizePath(folder ? `${folder}/${name}` : name);
}

/** Create without overwriting, following Obsidian's configured new-note folder. */
export async function createMindmapFile(app: App, sourcePath: string): Promise<TFile> {
  const requestedName = `${UNTITLED}.md`;
  const parent = app.fileManager.getNewFileParent(sourcePath, requestedName);
  let index = 1;
  let title = UNTITLED;
  let path = childPath(parent.path, `${title}.md`);
  while (app.vault.getAbstractFileByPath(path)) {
    index += 1;
    title = `${UNTITLED} ${index}`;
    path = childPath(parent.path, `${title}.md`);
  }
  return app.vault.create(path, newMindmapSource(title));
}
