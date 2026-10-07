// @vitest-environment jsdom
/**
 * LEV-240: the command 保存できなかった下書きを救出. A draft kept at a reload or quit that the next load could not write
 * stays kept (tests/ui/exit-drafts.test.ts); this command saves what it holds to a new note in `Mappy Recovery/`, only
 * through `vault.create`, without touching the original note or the kept entry. The rows are what the draft holds
 * (the note's text, the edit alone, only the reason) × the text in it that Markdown would read (fences, frontmatter,
 * comments) × the vault in the way (a file named like the folder, a name taken, a create refused).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice, Platform, TFile, TFolder } from '../browser-harness/obsidian';
import { frontmatterLayout } from '../../src/core/markdown';
import type { ExitDraft } from '../../src/core/exit-drafts';
import { setLanguage, t } from '../../src/i18n';
import { EXIT_DRAFTS_KEY } from '../../src/ui/exit-drafts';
import {
  RECOVERY_ATTEMPTS, RECOVERY_FOLDER, draftId, fenced, localTime, rescueExitDraft, rescueExitDrafts, rescuedBackupText, rescuedFileBase,
  rescuedNoteText, safeFileName,
} from '../../src/ui/exit-draft-recovery';
import { applyEdits } from '../../src/core/commands';
import { textFingerprint } from '../../src/core/exit-drafts';
import { appliedName, backupId, backupText, utf8Bytes } from '../../src/core/exit-backup';
import { discardExitBackup, keptBackupIds } from '../../src/ui/exit-drafts';
import { ExitBackupStore, exitBackupFolder, type BackupAdapter, type BackupRecord } from '../../src/obsidian/exit-backup-store';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

afterEach(() => {
  vi.restoreAllMocks();
  Notice.log.length = 0;
  document.body.replaceChildren();
});

const NOTE = 'Fixtures/退避の元.md';
const SOURCE = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', ''].join('\n');
const AT = new Date(2026, 9, 5, 7, 8, 9).getTime();

const withSource = (source = SOURCE): ExitDraft => ({
  path: NOTE, title: '入力中の題名', at: AT, before: `${source.length}:abc123`, after: '99:def456',
  edits: [{ from: 25, to: 29, text: '入力中の題名' }], source,
});
const withoutSource = (): ExitDraft => ({ path: NOTE, title: '原文なしの題名', at: AT, before: '512:abc', after: '520:def', edits: [{ from: 3, to: 7, text: '新しい' }] });
const refused = (): ExitDraft => ({ path: NOTE, title: '拒否された題名', at: AT, refused: '編集していたノードが見つかりません。' });

/** A vault holding the original note and whatever a row puts in the way; every call to it is logged. */
class FakeVault {
  readonly entries = new Map<string, TFile | TFolder>();
  readonly contents = new Map<string, string>();
  readonly calls: string[] = [];
  /** A create refused for these paths though nothing is there yet (another create got there first). */
  readonly refuse = new Set<string>();

  constructor() { this.file(NOTE, '元のノートの本文\n'); }

  file(path: string, content = ''): TFile {
    const file = new TFile();
    file.path = path;
    this.entries.set(path, file);
    this.contents.set(path, content);
    return file;
  }

  folder(path: string): TFolder {
    const folder = new TFolder();
    folder.path = path;
    this.entries.set(path, folder);
    return folder;
  }

  getAbstractFileByPath = (path: string): TFile | TFolder | null => this.entries.get(path) ?? null;
  /** The vault's top folder, holding what has no folder in its path. */
  getRoot = (): TFolder => {
    const root = new TFolder();
    root.path = '/';
    root.children = [...this.entries.values()].filter(entry => !entry.path.includes('/'));
    return root;
  };
  createFolder = (path: string): Promise<TFolder> => {
    this.calls.push(`createFolder ${path}`);
    if (this.entries.has(path)) return Promise.reject(new Error('Folder already exists.'));
    return Promise.resolve(this.folder(path));
  };
  create = (path: string, data: string): Promise<TFile> => {
    this.calls.push(`create ${path}`);
    if (this.entries.has(path) || this.refuse.has(path)) return Promise.reject(new Error('File already exists.'));
    return Promise.resolve(this.file(path, data));
  };
  // Nothing the rescue may call: each logs and throws, so a call shows in `calls` and fails the rescue.
  modify = (file: TFile): never => { this.calls.push(`modify ${file.path}`); throw new Error('modify'); };
  process = (file: TFile): never => { this.calls.push(`process ${file.path}`); throw new Error('process'); };
  append = (file: TFile): never => { this.calls.push(`append ${file.path}`); throw new Error('append'); };
  delete = (file: TFile): never => { this.calls.push(`delete ${file.path}`); throw new Error('delete'); };
  rename = (file: TFile): never => { this.calls.push(`rename ${file.path}`); throw new Error('rename'); };
}

/** The plugin's folder on disk, where the backups are (LEV-309); a row can make listing it fail. */
const PLUGIN = 'cfg/plugins/mappy';
const BACKUPS = exitBackupFolder(PLUGIN);
class Disk {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>([PLUGIN]);
  listFails = false;
  /** Whether the system trash takes a file (`trashSystem` answers false where there is none), or what it throws. */
  trashWorks = true;
  trashFails: Error | null = null;
  /** What the vault's own trash (`trashLocal`) throws, if anything. */
  localTrashFails: Error | null = null;
  /** What a read of a path throws, if anything. */
  readFails: (path: string) => Error | null = () => null;
  /** The files moved to the system trash and to the vault's `.trash/`, with what they held, and the calls that moved one. */
  readonly trash = new Map<string, string>();
  readonly localTrash = new Map<string, string>();
  readonly taken: string[] = [];
  private run<T>(body: () => T): Promise<T> {
    try { return Promise.resolve(body()); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  readonly adapter: BackupAdapter = {
    exists: path => this.run(() => this.files.has(path) || this.folders.has(path)),
    stat: path => this.run(() => this.folders.has(path) ? { type: 'folder' as const, ctime: 0, mtime: 0, size: 0 }
      : this.files.has(path) ? { type: 'file' as const, ctime: 0, mtime: 0, size: utf8Bytes(this.files.get(path)!) } : null),
    list: path => this.run(() => {
      if (this.listFails) throw new Error('EACCES');
      const under = (item: string) => item.startsWith(`${path}/`) && !item.slice(path.length + 1).includes('/');
      return { files: [...this.files.keys()].filter(under), folders: [...this.folders].filter(under) };
    }),
    read: path => this.run(() => {
      const failure = this.readFails(path);
      if (failure) throw failure;
      const text = this.files.get(path);
      if (text === undefined) throw new Error('ENOENT');
      return text;
    }),
    write: (path, data) => this.run(() => { this.files.set(path, data); }),
    rename: (from, to) => this.run(() => {
      const text = this.files.get(from);
      if (text === undefined || this.files.has(to)) throw new Error(`rename ${from} ${to}`);
      this.files.delete(from);
      this.files.set(to, text);
    }),
    mkdir: path => this.run(() => { this.folders.add(path); }),
    trashSystem: path => this.run(() => {
      this.taken.push(`trashSystem ${path}`);
      if (this.trashFails) throw this.trashFails;
      const text = this.files.get(path);
      if (!this.trashWorks || text === undefined) return false;
      this.files.delete(path);
      this.trash.set(path, text);
      return true;
    }),
    trashLocal: path => this.run(() => {
      this.taken.push(`trashLocal ${path}`);
      if (this.localTrashFails) throw this.localTrashFails;
      const text = this.files.get(path);
      if (text === undefined) throw new Error('ENOENT');
      this.files.delete(path);
      this.localTrash.set(path, text);
    }),
  };
}
const storeOn = (disk = new Disk(), now = () => AT) => new ExitBackupStore(disk.adapter, BACKUPS, '0.4.6', undefined, now);

/** The app the command sees: the vault and the vault's `localStorage` entry holding `drafts`. */
function appWith(drafts: readonly ExitDraft[] | null, vault = new FakeVault()): { app: App; vault: FakeVault; stored: () => string | null } {
  const storage = new Map<string, string>();
  if (drafts) storage.set(EXIT_DRAFTS_KEY, JSON.stringify(drafts));
  const app = {
    vault,
    loadLocalStorage: (key: string): unknown => { const raw = storage.get(key); return raw === undefined ? null : JSON.parse(raw); },
    saveLocalStorage: (key: string, data: unknown): void => { vault.calls.push(`saveLocalStorage ${key}`); storage.set(key, JSON.stringify(data)); },
  };
  return { app: app as unknown as App, vault, stored: () => storage.get(EXIT_DRAFTS_KEY) ?? null };
}

/** The text between the fence that opens right after `heading`'s line and the fence that closes it. */
function fencedAfter(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no ${heading}`);
  const lines = text.slice(start + heading.length + 2).split('\n');
  const open = lines.findIndex(line => /^`{3,}$/u.test(line));
  const fence = lines[open]!;
  const close = lines.findIndex((line, index) => index > open && line === fence);
  if (close === -1) throw new Error('the fence does not close');
  return lines.slice(open + 1, close).map(line => `${line}\n`).join('');
}

const buttons = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button'));
const button = (label: string): HTMLButtonElement => {
  const found = buttons().find(item => item.textContent === label);
  if (!found) throw new Error(`no button ${label}: ${buttons().map(item => item.textContent).join(', ')}`);
  return found;
};
/** The list's buttons that do `action` (`pick` or `discard`, LEV-310), a line's in its order. */
const actions = (action: 'pick' | 'discard'): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(`.modal button[data-mappy-rescue-action="${action}"]`));
const settle = async (): Promise<void> => { for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

describe('the rescued note (LEV-240)', () => {
  it('starts with a heading and has no frontmatter, so it is never a map', () => {
    const text = rescuedNoteText(withSource());
    expect(text.startsWith(`# ${t().recHeading('`退避の元`')}\n`)).toBe(true);
    expect(frontmatterLayout(text)).toBeNull();
    expect(text).toContain(`- ${t().recPath(`\`${NOTE}\``)}`);
    expect(text).toContain(`- ${t().recKeptAt('2026-10-05 07:08:09')}`);
    expect(text).toContain(`- ${t().recUnchanged}`);
    expect(text).toContain(`- ${t().recLength(String(SOURCE.length), `\`${SOURCE.length}:abc123\``)}`);
    expect(text).toContain(`- ${t().recEndsWithNewline}`);
  });

  it('holds the note text exactly in a fence when it ends with a line break', () => {
    const text = rescuedNoteText(withSource());
    expect(fencedAfter(text, `## ${t().recSourceHeading}`)).toBe(SOURCE);
    expect(text).not.toContain(t().recAddedNewline);
  });

  it('adds one line break for display when the note text does not end with one, and says so', () => {
    const source = SOURCE.trimEnd();
    const text = rescuedNoteText(withSource(source));
    expect(fencedAfter(text, `## ${t().recSourceHeading}`)).toBe(`${source}\n`);
    expect(text).toContain(t().recAddedNewline);
    expect(text).toContain(`- ${t().recEndsWithoutNewline}`);
  });

  it('makes the fence longer than any run of backticks in the note, and puts no info string on it', () => {
    const source = ['---', 'mappy: true', '---', '```js', 'code', '````', '%% comment %%', '`````inline`````', '~~~', '![[埋め込み]]', ''].join('\n');
    const text = rescuedNoteText(withSource(source));
    expect(text).toContain(`\n${'`'.repeat(6)}\n${source}${'`'.repeat(6)}\n`);
    expect(fencedAfter(text, `## ${t().recSourceHeading}`)).toBe(source);
    expect(frontmatterLayout(text)).toBeNull();
    expect(fenced('a')).toBe('```\na\n```');
    expect(fenced('``')).toBe('```\n``\n```');
    expect(fenced('````')).toBe('`````\n````\n`````');
  });

  it('fences the title and each planned change in their own sections', () => {
    const draft = { ...withSource(), title: '```題名```', edits: [{ from: 25, to: 29, text: '```題名```' }, { from: 40, to: 40, text: '' }] };
    const text = rescuedNoteText(draft);
    expect(fencedAfter(text, `## ${t().recTitleHeading}`)).toBe('```題名```\n');
    expect(text).toContain(`${t().recEdit('1', '25', '29')}\n\n\`\`\`\`\n\`\`\`題名\`\`\`\n\`\`\`\``);
    expect(text).toContain(`${t().recEdit('2', '40', '40')}\n\n\`\`\`\n\`\`\``);
  });

  it('says the note text was not saved for a draft kept without it, and holds its title and change', () => {
    const text = rescuedNoteText(withoutSource());
    expect(text).toContain(`## ${t().recSourceHeading}\n\n${t().recNoSource}\n`);
    expect(text).toContain(`- ${t().recLength('512', '`512:abc`')}`);
    expect(text).not.toContain(t().recEndsWithNewline);
    expect(text).not.toContain(t().recEndsWithoutNewline);
    expect(fencedAfter(text, `## ${t().recTitleHeading}`)).toBe('原文なしの題名\n');
    expect(text).toContain(`${t().recEdit('1', '3', '7')}\n\n\`\`\`\n新しい\n\`\`\``);
  });

  it('holds only the title and the reason for a draft that could not be planned', () => {
    const text = rescuedNoteText(refused());
    expect(text).toContain(t().recNoSource);
    expect(fencedAfter(text, `## ${t().recTitleHeading}`)).toBe('拒否された題名\n');
    expect(fencedAfter(text, `## ${t().recReasonHeading}`)).toBe('編集していたノードが見つかりません。\n');
    expect(text).not.toContain(t().recEditsHeading);
    expect(text).not.toContain(t().recLength('', '').slice(0, 4));
  });

  it('never says anything was restored', () => {
    for (const draft of [withSource(), withSource('abc'), withoutSource(), refused()]) {
      const text = rescuedNoteText(draft);
      expect(text).not.toContain('復元しました');
      expect(text).not.toContain('復元できる');
      expect(text).not.toContain('復元できます');
    }
  });
});

describe('the rescued file name (LEV-240)', () => {
  it('replaces what a file name or a link cannot hold, and drops a leading dot or space', () => {
    expect(safeFileName('a\\b/c:d*e?f"g<h>i|j#k^l[m]n')).toBe('a_b_c_d_e_f_g_h_i_j_k_l_m_n');
    expect(safeFileName('タブ\tと改行\n')).toBe('タブ_と改行_');
    expect(safeFileName(' . .隠し')).toBe('隠し');
    expect(safeFileName('')).toBe('draft');
    expect(safeFileName('...')).toBe('draft');
  });

  it('cuts a long name at 80 code points and 200 UTF-8 bytes without splitting a character', () => {
    expect(safeFileName('a'.repeat(100))).toBe('a'.repeat(80));
    expect(safeFileName('あ'.repeat(100))).toBe('あ'.repeat(66));
    expect(safeFileName('😀'.repeat(100))).toBe('😀'.repeat(50));
  });

  // Review 2: a long Japanese name gave a rescued file name over the 255 bytes a file name holds.
  it('keeps the whole file name within 255 UTF-8 bytes, number and extension included', () => {
    for (const name of ['あ'.repeat(100), '😀'.repeat(100), 'a'.repeat(300)]) {
      const file = `${rescuedFileBase({ ...withSource(), path: `${name}.md` })} ${RECOVERY_ATTEMPTS}.md`;
      expect(new TextEncoder().encode(file).length).toBeLessThanOrEqual(255);
    }
  });

  // Review of 22215d0: a finite time out of Date's range (kept by readExitDrafts) gave NaN in the name and the note.
  it('says the time is unknown for a time no date has', () => {
    const draft = { ...withSource(), at: 1e20 };
    expect(localTime(1e20)).toBe('unknown time');
    expect(rescuedFileBase(draft)).toBe(`退避の元 unknown time ${draftId(draft)}`);
    expect(rescuedNoteText(draft)).not.toContain('NaN');
  });

  it('is the note name, the local time it was kept and a six-character id', () => {
    expect(localTime(AT)).toBe('2026-10-05 07:08:09');
    expect(draftId(withSource())).toMatch(/^[0-9a-z]{6}$/u);
    expect(draftId(withSource())).not.toBe(draftId({ ...withSource(), at: AT + 1000 }));
    expect(rescuedFileBase(withSource())).toBe(`退避の元 2026-10-05 070809 ${draftId(withSource())}`);
  });
});

describe('saving a kept draft to a separate file (LEV-240)', () => {
  it('creates the folder and the file, changes nothing else and leaves the draft kept', async () => {
    const draft = withSource();
    const { app, vault, stored } = appWith([draft]);
    const before = stored();
    const message = await rescueExitDraft(app, draft);
    const path = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}.md`;
    expect(message).toBe(t().rescueSaved(path));
    expect(vault.calls).toEqual([`createFolder ${RECOVERY_FOLDER}`, `create ${path}`]);
    expect(vault.contents.get(path)).toBe(rescuedNoteText(draft));
    expect(vault.contents.get(NOTE)).toBe('元のノートの本文\n');
    expect(stored()).toBe(before);
  });

  it('uses the folder that is there, and the next number for a name taken', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.folder(RECOVERY_FOLDER);
    const base = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}`;
    vault.file(`${base}.md`, '前の救出');
    vault.file(`${base} 2.md`, '前の救出 2');
    const { app } = appWith([draft], vault);
    expect(await rescueExitDraft(app, draft)).toBe(t().rescueSaved(`${base} 3.md`));
    expect(vault.calls).toEqual([`create ${base} 3.md`]);
    expect(vault.contents.get(`${base}.md`)).toBe('前の救出');
    expect(vault.contents.get(`${base} 2.md`)).toBe('前の救出 2');
  });

  it('rescuing again makes another file, and the draft is still kept', async () => {
    const draft = withoutSource();
    const { app, vault, stored } = appWith([draft]);
    const before = stored();
    const base = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}`;
    await rescueExitDraft(app, draft);
    await rescueExitDraft(app, draft);
    expect([...vault.contents.keys()].filter(path => path.startsWith(RECOVERY_FOLDER))).toEqual([`${base}.md`, `${base} 2.md`]);
    expect(stored()).toBe(before);
  });

  it('moves to the next number when a create is refused for a name that looked free', async () => {
    const draft = refused();
    const vault = new FakeVault();
    const base = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}`;
    vault.refuse.add(`${base}.md`);
    const { app } = appWith([draft], vault);
    expect(await rescueExitDraft(app, draft)).toBe(t().rescueSaved(`${base} 2.md`));
    expect(vault.calls).toEqual([`createFolder ${RECOVERY_FOLDER}`, `create ${base}.md`, `create ${base} 2.md`]);
  });

  it('goes on when the folder appeared as its create was refused', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.createFolder = (path: string): Promise<TFolder> => {
      vault.calls.push(`createFolder ${path}`);
      vault.folder(path);
      return Promise.reject(new Error('Folder already exists.'));
    };
    const { app } = appWith([draft], vault);
    expect(await rescueExitDraft(app, draft)).toBe(t().rescueSaved(`${RECOVERY_FOLDER}/${rescuedFileBase(draft)}.md`));
  });

  // Review 2: the disk usually ignores case, and a folder `mappy recovery` made the folder's create fail at every rescue.
  it('uses a folder of the same name in another case, and is blocked by a file of it', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.folder('mappy recovery');
    const { app } = appWith([draft], vault);
    const path = `mappy recovery/${rescuedFileBase(draft)}.md`;
    expect(await rescueExitDraft(app, draft)).toBe(t().rescueSaved(path));
    expect(vault.calls).toEqual([`create ${path}`]);
    const blocked = new FakeVault();
    blocked.file('MAPPY RECOVERY', '同じ名前のファイル');
    expect(await rescueExitDraft(appWith([draft], blocked).app, draft)).toBe(`${t().rescueFolderIsFile(RECOVERY_FOLDER)}${t().rescueDraftKept}`);
    expect(blocked.calls).toEqual([]);
  });

  // Review of 22215d0: on Linux the disk usually tells case apart, and another folder or file of the name in another
  // case was taken for the folder.
  it('on Linux, takes only the exact folder name', async () => {
    const draft = withSource();
    Platform.isLinux = true;
    try {
      const vault = new FakeVault();
      vault.folder('mappy recovery');
      vault.file('MAPPY RECOVERY', '別のファイル');
      const { app } = appWith([draft], vault);
      const path = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}.md`;
      expect(await rescueExitDraft(app, draft)).toBe(t().rescueSaved(path));
      expect(vault.calls).toEqual([`createFolder ${RECOVERY_FOLDER}`, `create ${path}`]);
      expect(vault.contents.get('MAPPY RECOVERY')).toBe('別のファイル');
    } finally { Platform.isLinux = false; }
  });

  it('changes nothing when a file has the folder name, and says so', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.file(RECOVERY_FOLDER, '同じ名前のファイル');
    const { app, stored } = appWith([draft], vault);
    const before = stored();
    expect(await rescueExitDraft(app, draft)).toBe(`${t().rescueFolderIsFile(RECOVERY_FOLDER)}${t().rescueDraftKept}`);
    expect(vault.calls).toEqual([]);
    expect(vault.contents.get(RECOVERY_FOLDER)).toBe('同じ名前のファイル');
    expect(stored()).toBe(before);
  });

  it('says the draft is kept only when it is still in the entry', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.file(RECOVERY_FOLDER);
    const { app } = appWith([], vault);
    expect(await rescueExitDraft(app, draft)).toBe(t().rescueFolderIsFile(RECOVERY_FOLDER));
  });

  it('says why when the folder cannot be created', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.createFolder = (): Promise<TFolder> => Promise.reject(new Error('書き込みが許可されていません。'));
    const { app } = appWith([draft], vault);
    expect(await rescueExitDraft(app, draft)).toBe(`${t().rescueFailed('書き込みが許可されていません。')}${t().rescueDraftKept}`);
  });

  // Review 1: an error without a message was reported as no free name being left.
  it('says the reason is unknown for an error without a message, not that no name is free', async () => {
    const draft = withSource();
    for (const thrown of [new Error(''), 'not an error'] as unknown[]) {
      const vault = new FakeVault();
      vault.create = (path: string): Promise<TFile> => { vault.calls.push(`create ${path}`); throw thrown; };
      const { app } = appWith([draft], vault);
      expect(await rescueExitDraft(app, draft)).toBe(`${t().rescueFailed(t().rescueUnknownReason)}${t().rescueDraftKept}`);
      expect(vault.calls.filter(call => call.startsWith('create '))).toHaveLength(RECOVERY_ATTEMPTS);
    }
  });

  it(`gives up after ${RECOVERY_ATTEMPTS} names, and says so`, async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.folder(RECOVERY_FOLDER);
    const base = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}`;
    for (let number = 1; number <= RECOVERY_ATTEMPTS; number += 1) vault.file(`${base}${number === 1 ? '' : ` ${number}`}.md`, 'x');
    const { app } = appWith([draft], vault);
    expect(await rescueExitDraft(app, draft)).toBe(`${t().rescueFailed(t().rescueNoFreeName)}${t().rescueDraftKept}`);
    expect(vault.calls).toEqual([]);
  });
});

describe('the command 保存できなかった下書きを救出 (LEV-240)', () => {
  it('says there is nothing to rescue when no draft is kept', async () => {
    await rescueExitDrafts(appWith(null).app, storeOn());
    expect(Notice.log).toEqual([t().rescueNone]);
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('lists each kept draft with where, when, its title and what it holds', async () => {
    await rescueExitDrafts(appWith([withSource(), withoutSource(), refused()]).app, storeOn());
    const rows = Array.from(document.querySelectorAll('.modal .setting-item'), row => [
      row.querySelector('.setting-item-name')?.textContent, row.querySelector('.setting-item-description')?.textContent]);
    const when = t().rescueKeptAt('2026-10-05 07:08:09');
    expect(rows).toEqual([
      [NOTE, `${when} · ${t().rescueTitleLine('入力中の題名')} · ${t().rescueHasSource(String(SOURCE.length))}`],
      [NOTE, `${when} · ${t().rescueTitleLine('原文なしの題名')} · ${t().rescueNoSource}`],
      [NOTE, `${when} · ${t().rescueTitleLine('拒否された題名')} · ${t().rescueRefused('編集していたノードが見つかりません。')}`],
    ]);
    expect(document.querySelector('.modal-title')?.textContent).toBe(t().cmdRescueDrafts);
  });

  it('saves the chosen draft after the confirmation, and says where', async () => {
    const draft = withSource();
    const { app, vault, stored } = appWith([withoutSource(), draft]);
    const before = stored();
    await rescueExitDrafts(app, storeOn());
    actions('pick')[1]!.click();
    const path = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}.md`;
    const shown = Array.from(document.querySelectorAll('.modal p'), item => item.textContent);
    expect(shown).toEqual([t().rescueConfirmPath(path), t().rescueConfirmSource(String(SOURCE.length)), t().rescueConfirmUnchanged]);
    expect(button(t().rescueSave).classList.contains('mod-cta')).toBe(true);
    expect(vault.calls).toEqual([]);
    button(t().rescueSave).click();
    await settle();
    expect(document.querySelector('.modal')).toBeNull();
    expect(vault.contents.get(path)).toBe(rescuedNoteText(draft));
    expect(vault.contents.get(NOTE)).toBe('元のノートの本文\n');
    expect(stored()).toBe(before);
    expect(Notice.log).toEqual([t().rescueSaved(path)]);
  });

  // Review 2: the confirmation named the first name though the rescue was to take the next free one.
  it('names in the confirmation the path the rescue will take', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.folder(RECOVERY_FOLDER);
    const base = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}`;
    vault.file(`${base}.md`, '前の救出');
    const { app } = appWith([draft], vault);
    await rescueExitDrafts(app, storeOn());
    button(t().rescuePick).click();
    expect(document.querySelector('.modal p')?.textContent).toBe(t().rescueConfirmPath(`${base} 2.md`));
    button(t().rescueSave).click();
    await settle();
    expect(Notice.log).toEqual([t().rescueSaved(`${base} 2.md`)]);
  });

  // Review 3: the confirmation named a path in the folder's place though a file is there, and offered to save.
  it('says in the confirmation that a file has the folder name, and offers no save', async () => {
    const vault = new FakeVault();
    vault.file('Mappy recovery', '同じ名前のファイル');
    await rescueExitDrafts(appWith([withSource()], vault).app, storeOn());
    button(t().rescuePick).click();
    expect(document.querySelector('.modal p')?.textContent).toBe(t().rescueConfirmFolderIsFile(RECOVERY_FOLDER));
    expect(t().rescueConfirmFolderIsFile(RECOVERY_FOLDER)).not.toContain('でした');
    expect(button(t().rescueSave).disabled).toBe(true);
    expect(vault.calls).toEqual([]);
  });

  // Independent review of 2a0eedb (L6): with every name taken, the confirmation named one that exists.
  it('says in the confirmation that no name is free, offers no save, and overwrites nothing', async () => {
    const draft = withSource();
    const vault = new FakeVault();
    vault.folder(RECOVERY_FOLDER);
    const base = `${RECOVERY_FOLDER}/${rescuedFileBase(draft)}`;
    for (let number = 1; number <= RECOVERY_ATTEMPTS; number += 1) vault.file(`${base}${number === 1 ? '' : ` ${number}`}.md`, `前の救出 ${number}`);
    await rescueExitDrafts(appWith([draft], vault).app, storeOn());
    button(t().rescuePick).click();
    expect(document.querySelector('.modal p')?.textContent).toBe(t().rescueConfirmNoFreeName);
    expect(t().rescueConfirmNoFreeName).not.toContain('でした');
    expect(button(t().rescueSave).disabled).toBe(true);
    expect(vault.calls).toEqual([]);
    expect(vault.contents.get(`${base}.md`)).toBe('前の救出 1');
  });

  // Review 3: the success Notice said the draft was kept without looking.
  it('does not say the draft is kept after a rescue when it is no longer in the entry', async () => {
    const draft = withSource();
    const { app } = appWith([], new FakeVault());
    expect(await rescueExitDraft(app, draft)).toBe(t().rescueSavedNotKept(`${RECOVERY_FOLDER}/${rescuedFileBase(draft)}.md`));
  });

  // Independent review of 0dd1d43 (B): the English confirmation read 'Saved to:' before anything was saved.
  it('names the destination in the English confirmation without saying it is saved', async () => {
    setLanguage('en');
    try {
      await rescueExitDrafts(appWith([withSource()]).app, storeOn());
      button('Choose').click();
      const shown = document.querySelector('.modal p')?.textContent ?? '';
      expect(shown).toBe(`Destination: ${RECOVERY_FOLDER}/${rescuedFileBase(withSource())}.md (a number is added if the name is taken)`);
      expect(shown).not.toMatch(/saved/iu);
    } finally { setLanguage('ja'); }
  });

  it('writes nothing when the confirmation is cancelled', async () => {
    const { app, vault, stored } = appWith([refused()]);
    const before = stored();
    await rescueExitDrafts(app, storeOn());
    button(t().rescuePick).click();
    expect(document.querySelector('.modal p')?.textContent).toBe(t().rescueConfirmPath(`${RECOVERY_FOLDER}/${rescuedFileBase(refused())}.md`));
    button(t().rescueCancel).click();
    await settle();
    expect(document.querySelector('.modal')).toBeNull();
    expect(vault.calls).toEqual([]);
    expect(stored()).toBe(before);
    expect(Notice.log).toEqual([]);
  });
});

/**
 * LEV-309: the backups every write of a kept draft leaves first (src/obsidian/exit-backup-store.ts) are listed after
 * the kept drafts, finished (`applied`) or not (`prepared`), and saved the same way, through `vault.create` only; a
 * file in the backup folder that does not read as one, or the folder itself when it cannot be read, is shown by its
 * path alone, with nothing to save. The backups are not changed by the rescue.
 */
/** The map note the backups' rows write into (LEV-309, LEV-310). */
const MAP = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', '- 別のノード', ''].join('\n');
/** A draft renaming 「子ノード」 in `MAP` to `title`, as `pagehide` keeps it. */
const planned = (title: string, withSource = true): Exclude<ExitDraft, { refused: string }> => {
  const edits = [{ from: MAP.indexOf('子ノード'), to: MAP.indexOf('子ノード') + 4, text: title }];
  return { path: NOTE, title, at: AT, before: textFingerprint(MAP), after: textFingerprint(applyEdits(MAP, edits)), edits, ...(withSource ? { source: MAP } : {}) };
};
/** A backup made by the store on `disk` of writing `draft` into the note holding `before`, marked applied when `finish`. */
async function backUp(disk: Disk, draft: Exclude<ExitDraft, { refused: string }>, before: string, finish: boolean, at = AT): Promise<BackupRecord> {
  const store = storeOn(disk, () => at);
  await store.prepare(draft, draft.path, before, applyEdits(before, draft.edits), draft.edits);
  if (finish) await store.markApplied(await backupId(draft));
  const survey = await store.survey();
  const entry = survey.records.get(await backupId(draft))!;
  return (finish ? entry.applied : entry.prepared)!;
}

describe('the backups the writes of kept drafts left (LEV-309)', () => {
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.modal .setting-item'), row => ({
    kind: row.dataset.mappyRescue, name: row.querySelector('.setting-item-name')?.textContent,
    desc: row.querySelector('.setting-item-description')?.textContent, pick: row.querySelector('button') !== null,
  }));

  it('lists the backups after the kept drafts, the newest first, and the files it cannot read by their path alone', async () => {
    const disk = new Disk();
    await backUp(disk, planned('書いた題名'), MAP, true, AT);
    await backUp(disk, planned('途中の題名'), `${MAP}- 足した\n`, false, AT + 60_000);
    disk.files.set(`${BACKUPS}/${'a'.repeat(64)}.tmp-000000000000.json`, '{');
    const { app } = appWith([withSource()]);
    await rescueExitDrafts(app, storeOn(disk));
    const time = (at: number) => t().rescueBackupAt(localTime(at));
    expect(rows()).toEqual([
      { kind: 'draft', name: NOTE, desc: `${t().rescueKeptAt('2026-10-05 07:08:09')} · ${t().rescueTitleLine('入力中の題名')} · ${t().rescueHasSource(String(SOURCE.length))}`, pick: true },
      { kind: 'prepared', name: NOTE, desc: `${t().rescueBackupPrepared} · ${time(AT + 60_000)} · ${t().rescueTitleLine('途中の題名')}`, pick: true },
      { kind: 'applied', name: NOTE, desc: `${t().rescueBackupApplied} · ${time(AT)} · ${t().rescueTitleLine('書いた題名')}`, pick: true },
      { kind: 'unchecked', name: `${BACKUPS}/${'a'.repeat(64)}.tmp-000000000000.json`, desc: t().rescueUnchecked, pick: false },
    ]);
  });

  it('lists the backups when no draft is kept, and the backup folder when it cannot be read', async () => {
    const disk = new Disk();
    await backUp(disk, planned('書いた題名'), MAP, true);
    await rescueExitDrafts(appWith(null).app, storeOn(disk));
    expect(rows().map(row => row.kind)).toEqual(['applied']);
    document.body.replaceChildren();
    disk.listFails = true;
    await rescueExitDrafts(appWith(null).app, storeOn(disk));
    expect(rows()).toEqual([{ kind: 'unchecked', name: BACKUPS, desc: t().rescueUnlisted, pick: false }]);
    expect(Notice.log).toEqual([]);
  });

  // Acceptance 9: a backup saved to a new file, as a kept draft is.
  it('saves a chosen backup to a new file after the confirmation: the note before the write, the draft\'s text, the change', async () => {
    const disk = new Disk();
    const before = `${MAP}- 書く前にあった行\n`;
    const record = await backUp(disk, planned('書いた題名'), before, true);
    const files = new Map(disk.files);
    const { app, vault, stored } = appWith(null);
    await rescueExitDrafts(app, storeOn(disk));
    button(t().rescuePick).click();
    const path = `${RECOVERY_FOLDER}/${rescuedFileBase(record.backup.draft)}.md`;
    expect(Array.from(document.querySelectorAll('.modal p'), item => item.textContent))
      .toEqual([t().rescueConfirmPath(path), t().rescueConfirmBackup(String(before.length)), t().rescueConfirmUnchanged]);
    button(t().rescueSave).click();
    await settle();
    const text = vault.contents.get(path)!;
    expect(text).toBe(rescuedBackupText(record));
    expect(fencedAfter(text, `## ${t().recBeforeHeading}`)).toBe(before);
    expect(fencedAfter(text, `## ${t().recSourceHeading}`)).toBe(MAP);
    expect(text).toContain(t().recBackupApplied);
    expect(text).toContain(t().recBeforeIs);
    expect(Notice.log).toEqual([t().rescueSavedBackup(path)]);
    expect(disk.files).toEqual(files);
    expect(stored()).toBeNull();
    expect(vault.calls).toEqual([`createFolder ${RECOVERY_FOLDER}`, `create ${path}`]);
  });

  it('says the backup of a draft kept without its note text holds the note at the write, not a text lost before it', async () => {
    const disk = new Disk();
    const record = await backUp(disk, planned('原文なしの題名', false), MAP, false);
    const text = rescuedBackupText(record);
    expect(text).toContain(t().recBeforeNotOriginal);
    expect(text).not.toContain(t().recBeforeIs);
    expect(text).toContain(t().recNoSource);
    expect(text).toContain(t().recBackupPrepared);
    expect(fencedAfter(text, `## ${t().recBeforeHeading}`)).toBe(MAP);
    for (const word of ['復元しました', '復元できます', '失いません', 'restored']) expect(text).not.toContain(word);
  });

  it('names the backup by the applied file it read, and changes no backup file when the save fails', async () => {
    const disk = new Disk();
    const draft = planned('書いた題名');
    const record = await backUp(disk, draft, MAP, true);
    expect(record.path).toBe(`${BACKUPS}/${appliedName(await backupId(draft))}`);
    const vault = new FakeVault();
    vault.file(RECOVERY_FOLDER, 'フォルダの名前のファイル');
    const files = new Map(disk.files);
    const { app } = appWith(null, vault);
    await rescueExitDrafts(app, storeOn(disk));
    button(t().rescuePick).click();
    expect(button(t().rescueSave).disabled).toBe(true);
    expect(disk.files).toEqual(files);
  });
});

/**
 * LEV-310: 破棄 on a line of the list takes that one kept draft or backup away, after a confirmation saying what goes;
 * キャンセル changes nothing. Nothing is discarded otherwise. The rows are what is discarded (a kept draft, a finished or
 * unfinished backup) × the answer (cancel, confirm) × what changed since the list was read (nothing, the draft written,
 * the backup renamed, changed or removed, storage or the trash refusing) × what must stay (the other drafts, an item
 * that does not read, the other files in the backup folder, the note).
 */
const lineOf = (kind: string, title: string): HTMLElement => {
  const line = Array.from(document.querySelectorAll<HTMLElement>(`.modal .setting-item[data-mappy-rescue="${kind}"]`))
    .find(row => row.querySelector('.setting-item-description')?.textContent?.includes(t().rescueTitleLine(title)));
  if (!line) throw new Error(`no ${kind} line for ${title}`);
  return line;
};
const press = (line: HTMLElement, action: 'pick' | 'discard'): void => {
  line.querySelector<HTMLButtonElement>(`button[data-mappy-rescue-action="${action}"]`)!.click();
};
const shownTexts = (): (string | null)[] => Array.from(document.querySelectorAll('.modal p'), item => item.textContent);

describe('discarding a kept draft from the list (LEV-310)', () => {
  const other = (): ExitDraft => ({ ...withSource(), title: '残す下書き', at: AT + 1000 });
  const unreadable = { path: 'Fixtures/読めない.md', title: 1 };
  /** The entry: a draft of another note, an item that does not read, the draft to discard, another of the same note. */
  const entry = (): unknown[] => [{ ...withoutSource(), path: 'Fixtures/別のノート.md' }, unreadable, withSource(), other()];

  it('offers 破棄 beside 選ぶ on each draft and backup line, and nothing on a line that does not read', async () => {
    const disk = new Disk();
    await backUp(disk, planned('書いた題名'), MAP, true);
    disk.files.set(`${BACKUPS}/${'a'.repeat(64)}.tmp-000000000000.json`, '{');
    await rescueExitDrafts(appWith([withSource(), refused()]).app, storeOn(disk));
    const offered = Array.from(document.querySelectorAll<HTMLElement>('.modal .setting-item'), row => [row.dataset.mappyRescue,
      Array.from(row.querySelectorAll('button'), item => `${item.dataset.mappyRescueAction}:${item.textContent}`)]);
    const both = [`pick:${t().rescuePick}`, `discard:${t().rescueDiscard}`];
    expect(offered).toEqual([['draft', both], ['draft', both], ['applied', both], ['unchecked', []]]);
    expect(document.querySelector('.modal p')?.textContent).toBe(t().rescueLead);
  });

  it('says what goes before anything is discarded, and changes nothing on キャンセル', async () => {
    const disk = new Disk();
    await backUp(disk, planned('書いた題名'), MAP, true);
    const files = new Map(disk.files);
    const { app, vault, stored } = appWith(entry() as ExitDraft[]);
    const before = stored();
    await rescueExitDrafts(app, storeOn(disk));
    press(lineOf('draft', '入力中の題名'), 'discard');
    expect(document.querySelector('.modal-title')?.textContent).toBe(t().discardDraftTitle);
    expect(shownTexts()).toEqual([t().discardDraftWhat('入力中の題名', NOTE), t().discardDraftLost, t().discardUnchanged]);
    expect(button(t().discardConfirm).classList.contains('mod-destructive')).toBe(true);
    expect(stored()).toBe(before);
    button(t().rescueCancel).click();
    await settle();
    expect(document.querySelector('.modal')).toBeNull();
    expect(stored()).toBe(before);
    expect(vault.calls).toEqual([]);
    expect(disk.files).toEqual(files);
    expect(disk.taken).toEqual([]);
    expect(Notice.log).toEqual([]);
  });

  it('takes out only that draft on 破棄する: the other drafts, an item that does not read, the backups and the note stay', async () => {
    const disk = new Disk();
    await backUp(disk, planned('書いた題名'), MAP, true);
    const files = new Map(disk.files);
    const { app, vault, stored } = appWith(entry() as ExitDraft[]);
    await rescueExitDrafts(app, storeOn(disk));
    press(lineOf('draft', '入力中の題名'), 'discard');
    button(t().discardConfirm).click();
    await settle();
    expect(document.querySelector('.modal')).toBeNull();
    const [another, , , kept] = entry();
    expect(JSON.parse(stored()!)).toEqual([another, unreadable, kept]);
    // The entry written once, and nothing else: no note read or written, no backup touched.
    expect(vault.calls).toEqual([`saveLocalStorage ${EXIT_DRAFTS_KEY}`]);
    expect(vault.contents.get(NOTE)).toBe('元のノートの本文\n');
    expect(disk.files).toEqual(files);
    expect(disk.taken).toEqual([]);
    expect(Notice.log).toEqual([t().discardedDraft('入力中の題名')]);
  });

  // Review 3: the entry holding the same draft twice (once kept again without its note text), the first of the two went
  // whichever line was pressed.
  it('takes out the very item of the line pressed when the entry holds the same draft twice', async () => {
    const bare = { ...withSource() } as { source?: string };
    delete bare.source;
    const { app, stored } = appWith([withSource(), bare as ExitDraft]);
    await rescueExitDrafts(app, storeOn());
    expect(Array.from(document.querySelectorAll('.modal .setting-item-description'), row => row.textContent?.endsWith(t().rescueNoSource))).toEqual([false, true]);
    actions('discard')[1]!.click();
    button(t().discardConfirm).click();
    await settle();
    expect(JSON.parse(stored()!)).toEqual([withSource()]);
    expect(Notice.log).toEqual([t().discardedDraft('入力中の題名')]);
  });

  // Review 3: the confirmation of a draft that could not be planned spoke of a planned change and a note text it never had.
  it('says only the title and the reason go for a draft that could not be planned', async () => {
    await rescueExitDrafts(appWith([refused()]).app, storeOn());
    press(lineOf('draft', '拒否された題名'), 'discard');
    expect(shownTexts()).toEqual([t().discardDraftWhat('拒否された題名', NOTE), t().discardDraftLostRefused, t().discardUnchanged]);
  });

  it('leaves no entry when the last kept draft is discarded', async () => {
    const { app, stored } = appWith([refused()]);
    await rescueExitDrafts(app, storeOn());
    press(lineOf('draft', '拒否された題名'), 'discard');
    button(t().discardConfirm).click();
    await settle();
    expect(stored()).toBe('null');
    expect(Notice.log).toEqual([t().discardedDraft('拒否された題名')]);
  });

  it('discards nothing and says so when the draft is no longer kept (written while the confirmation was open)', async () => {
    const { app, vault, stored } = appWith([withSource(), other()]);
    await rescueExitDrafts(app, storeOn());
    press(lineOf('draft', '入力中の題名'), 'discard');
    (app as unknown as { saveLocalStorage(key: string, data: unknown): void }).saveLocalStorage(EXIT_DRAFTS_KEY, [other()]);
    const before = stored();
    vault.calls.length = 0;
    button(t().discardConfirm).click();
    await settle();
    expect(stored()).toBe(before);
    expect(vault.calls).toEqual([]);
    expect(Notice.log).toEqual([t().discardDraftGone]);
  });

  it('says it could not discard when storage refuses the write, and the draft stays', async () => {
    const { app, stored } = appWith([withSource(), other()]);
    const before = stored();
    (app as unknown as { saveLocalStorage(): void }).saveLocalStorage = () => { throw new Error('QuotaExceededError'); };
    await rescueExitDrafts(app, storeOn());
    press(lineOf('draft', '入力中の題名'), 'discard');
    button(t().discardConfirm).click();
    await settle();
    expect(stored()).toBe(before);
    expect(Notice.log).toEqual([t().discardDraftFailed]);
  });

  it('does not say the draft was discarded when the entry cannot be read back', async () => {
    const { app } = appWith([withSource(), other()]);
    const reader = app as unknown as { loadLocalStorage(key: string): unknown };
    const load = reader.loadLocalStorage.bind(reader);
    let reads = 0;
    // The list's read, the discard's own and the one before taking the draft out, then the read back fails.
    reader.loadLocalStorage = (key: string): unknown => { reads += 1; if (reads > 3) throw new Error('SecurityError'); return load(key); };
    await rescueExitDrafts(app, storeOn());
    press(lineOf('draft', '入力中の題名'), 'discard');
    button(t().discardConfirm).click();
    await settle();
    expect(Notice.log).toEqual([t().discardDraftUnconfirmed]);
  });
});

describe('discarding a backup from the list (LEV-310)', () => {
  it('says what goes before anything is discarded, and changes nothing on キャンセル', async () => {
    const disk = new Disk();
    const before = `${MAP}- 書く前にあった行\n`;
    const record = await backUp(disk, planned('書いた題名'), before, true);
    const files = new Map(disk.files);
    const { app, vault, stored } = appWith([withSource()]);
    const entry = stored();
    await rescueExitDrafts(app, storeOn(disk));
    press(lineOf('applied', '書いた題名'), 'discard');
    await settle();
    expect(document.querySelector('.modal-title')?.textContent).toBe(t().discardBackupTitle);
    expect(shownTexts()).toEqual([t().discardBackupWhat('書いた題名', NOTE, localTime(record.backup.createdAt)),
      t().discardBackupLost(String(before.length)), t().discardUnchanged]);
    expect(button(t().discardConfirm).disabled).toBe(false);
    expect(button(t().discardConfirm).classList.contains('mod-destructive')).toBe(true);
    button(t().rescueCancel).click();
    await settle();
    expect(document.querySelector('.modal')).toBeNull();
    expect(disk.files).toEqual(files);
    expect(disk.taken).toEqual([]);
    expect(stored()).toBe(entry);
    expect(vault.calls).toEqual([]);
    expect(Notice.log).toEqual([]);
  });

  it('moves only that backup to the system trash on 破棄する: the other files, the drafts and the note stay', async () => {
    const disk = new Disk();
    const done = await backUp(disk, planned('書いた題名'), MAP, true);
    const pending = await backUp(disk, planned('途中の題名'), MAP, false, AT + 60_000);
    disk.files.set(`${BACKUPS}/memo.txt`, 'x');
    const files = new Map(disk.files);
    const text = files.get(done.path)!;
    const { app, vault, stored } = appWith([withSource()]);
    const entry = stored();
    await rescueExitDrafts(app, storeOn(disk));
    press(lineOf('applied', '書いた題名'), 'discard');
    await settle();
    button(t().discardConfirm).click();
    await settle();
    files.delete(done.path);
    expect(disk.files).toEqual(files);
    expect(disk.files.has(pending.path)).toBe(true);
    expect([...disk.trash]).toEqual([[done.path, text]]);
    expect(disk.taken).toEqual([`trashSystem ${done.path}`]);
    expect(stored()).toBe(entry);
    expect(vault.calls).toEqual([]);
    expect(Notice.log).toEqual([t().discardedBackupTrash]);
  });

  // Review 1: where the system trash could not take it, the backup was deleted for good.
  it('moves it to the vault\'s .trash where the system trash cannot take it, and says so', async () => {
    const disk = new Disk();
    disk.trashWorks = false;
    const record = await backUp(disk, planned('書いた題名'), MAP, true);
    const text = disk.files.get(record.path)!;
    await rescueExitDrafts(appWith(null).app, storeOn(disk));
    press(lineOf('applied', '書いた題名'), 'discard');
    await settle();
    button(t().discardConfirm).click();
    await settle();
    expect(disk.files.has(record.path)).toBe(false);
    expect(disk.trash.size).toBe(0);
    expect([...disk.localTrash]).toEqual([[record.path, text]]);
    expect(disk.taken).toEqual([`trashSystem ${record.path}`, `trashLocal ${record.path}`]);
    expect(Notice.log).toEqual([t().discardedBackupLocalTrash]);
  });

  // The record is what keeps its kept draft from being written again (a write that did not finish): taking it away
  // could let the next load write the draft once more, so a discard never does.
  it.each([['with its note text', true], ['kept again without it', false]])('offers no discard of a backup whose draft is kept (%s), and refuses one asked for', async (_shape, withText) => {
    const disk = new Disk();
    const draft = planned('途中の題名');
    const record = await backUp(disk, draft, MAP, false);
    const files = new Map(disk.files);
    const { app, stored } = appWith([withText ? draft : planned('途中の題名', false)]);
    const entry = stored();
    await rescueExitDrafts(app, storeOn(disk));
    press(lineOf('prepared', '途中の題名'), 'discard');
    await settle();
    expect(shownTexts()).toEqual([t().discardBackupWhat('途中の題名', NOTE, localTime(record.backup.createdAt)),
      t().discardBackupDraftKept, t().discardUnchanged]);
    expect(button(t().discardConfirm).disabled).toBe(true);
    expect(await discardExitBackup(app, storeOn(disk), record)).toBe('draftKept');
    expect(disk.files).toEqual(files);
    expect(disk.taken).toEqual([]);
    expect(stored()).toBe(entry);
  });

  it.each(['renamed to the applied name', 'changed', 'removed'])('discards nothing and says so when the backup was %s while the confirmation was open', async change => {
    const disk = new Disk();
    const draft = planned('途中の題名');
    const record = await backUp(disk, draft, MAP, false);
    await rescueExitDrafts(appWith(null).app, storeOn(disk));
    press(lineOf('prepared', '途中の題名'), 'discard');
    await settle();
    if (change === 'renamed to the applied name') await storeOn(disk).markApplied(await backupId(draft));
    else if (change === 'changed') disk.files.set(record.path, backupText({ ...record.backup, createdAt: AT + 1 }));
    else disk.files.delete(record.path);
    const files = new Map(disk.files);
    button(t().discardConfirm).click();
    await settle();
    expect(disk.files).toEqual(files);
    expect(disk.taken).toEqual([]);
    expect(Notice.log).toEqual([t().discardBackupGone]);
  });

  it('says why when neither trash takes the backup, and leaves it', async () => {
    const disk = new Disk();
    const record = await backUp(disk, planned('書いた題名'), MAP, true);
    const files = new Map(disk.files);
    disk.trashFails = new Error('EPERM: operation not permitted');
    disk.localTrashFails = new Error('EBUSY: resource busy or locked');
    await rescueExitDrafts(appWith(null).app, storeOn(disk));
    press(lineOf('applied', '書いた題名'), 'discard');
    await settle();
    button(t().discardConfirm).click();
    await settle();
    expect(disk.files).toEqual(files);
    expect(disk.files.has(record.path)).toBe(true);
    expect(Notice.log).toEqual([t().discardBackupFailed('EBUSY: resource busy or locked')]);
  });

  // Review 1: a backup that could not be read was told as gone or changed.
  it('says why when the backup cannot be read, and takes nothing away', async () => {
    const disk = new Disk();
    const record = await backUp(disk, planned('書いた題名'), MAP, true);
    const files = new Map(disk.files);
    await rescueExitDrafts(appWith(null).app, storeOn(disk));
    disk.readFails = path => path === record.path ? new Error('EACCES: permission denied') : null;
    press(lineOf('applied', '書いた題名'), 'discard');
    await settle();
    button(t().discardConfirm).click();
    await settle();
    expect(disk.files).toEqual(files);
    expect(disk.taken).toEqual([]);
    expect(Notice.log).toEqual([t().discardBackupFailed('EACCES: permission denied')]);
  });

  // Review 1: the list hashed every kept draft before it opened, and a hash that failed left the command with nothing.
  it('opens the list when the kept drafts cannot be hashed, and offers no discard of a backup then', async () => {
    const disk = new Disk();
    await backUp(disk, planned('書いた題名'), MAP, true);
    const { app } = appWith([withSource()]);
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('OperationError'));
    await rescueExitDrafts(app, storeOn(disk));
    expect(Array.from(document.querySelectorAll<HTMLElement>('.modal .setting-item'), row => row.dataset.mappyRescue)).toEqual(['draft', 'unchecked']);
    digest.mockRestore();
    document.body.replaceChildren();
    // The list read, then the hashes fail as 破棄 is pressed: nothing is offered.
    await rescueExitDrafts(app, storeOn(disk));
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('OperationError'));
    press(lineOf('applied', '書いた題名'), 'discard');
    await settle();
    expect(shownTexts()[1]).toBe(t().discardBackupDraftsUnread);
    expect(button(t().discardConfirm).disabled).toBe(true);
    expect(await keptBackupIds(app)).toBeNull();
    expect(disk.taken).toEqual([]);
  });

  // Review 1: whether the draft held the backup back was read when the list opened, not when 破棄 was pressed.
  it('offers the discard of a backup whose draft was written after the list was read', async () => {
    const disk = new Disk();
    const draft = planned('途中の題名');
    const record = await backUp(disk, draft, MAP, false);
    const { app } = appWith([draft]);
    await rescueExitDrafts(app, storeOn(disk));
    (app as unknown as { saveLocalStorage(key: string, data: unknown): void }).saveLocalStorage(EXIT_DRAFTS_KEY, null);
    press(lineOf('prepared', '途中の題名'), 'discard');
    await settle();
    expect(shownTexts()[1]).toBe(t().discardBackupLost(String(record.backup.note.beforeLength)));
    button(t().discardConfirm).click();
    await settle();
    expect(disk.files.has(record.path)).toBe(false);
    expect(Notice.log).toEqual([t().discardedBackupTrash]);
  });

  it('refuses when the kept drafts cannot be read, and takes nothing away', async () => {
    const disk = new Disk();
    const record = await backUp(disk, planned('書いた題名'), MAP, true);
    const files = new Map(disk.files);
    const { app } = appWith(null);
    (app as unknown as { loadLocalStorage(): unknown }).loadLocalStorage = () => { throw new Error('SecurityError'); };
    expect(await discardExitBackup(app, storeOn(disk), record)).toBe('unread');
    expect(disk.files).toEqual(files);
    expect(disk.taken).toEqual([]);
  });

  it('says it in English too', async () => {
    setLanguage('en');
    try {
      const disk = new Disk();
      await backUp(disk, planned('書いた題名'), MAP, true);
      await rescueExitDrafts(appWith([withSource()]).app, storeOn(disk));
      const labels = Array.from(document.querySelectorAll('.modal button'), item => item.textContent);
      expect(labels).toEqual(['Choose', 'Discard', 'Choose', 'Discard']);
      press(lineOf('draft', '入力中の題名'), 'discard');
      expect(document.querySelector('.modal-title')?.textContent).toBe('Discard draft');
      expect(Array.from(document.querySelectorAll('.modal button'), item => item.textContent)).toEqual(['Discard', 'Cancel']);
      // The draft's own title and note path are Japanese; nothing else is.
      for (const shown of shownTexts()) expect(shown?.replaceAll('入力中の題名', '').replaceAll(NOTE, '')).not.toMatch(/[ぁ-んァ-ン]/u);
    } finally { setLanguage('ja'); }
  });
});
