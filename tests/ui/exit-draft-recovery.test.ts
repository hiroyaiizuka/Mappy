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
import { Notice, TFile, TFolder } from '../browser-harness/obsidian';
import { frontmatterLayout } from '../../src/core/markdown';
import type { ExitDraft } from '../../src/core/exit-drafts';
import { t } from '../../src/i18n';
import { EXIT_DRAFTS_KEY } from '../../src/ui/exit-drafts';
import {
  RECOVERY_ATTEMPTS, RECOVERY_FOLDER, draftId, fenced, localTime, rescueExitDraft, rescueExitDrafts, rescuedFileBase,
  rescuedNoteText, safeFileName,
} from '../../src/ui/exit-draft-recovery';

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

  it('cuts a long name at 80 code points without splitting a character', () => {
    expect(Array.from(safeFileName('あ'.repeat(100)))).toHaveLength(80);
    expect(safeFileName('😀'.repeat(100))).toBe('😀'.repeat(80));
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
    expect(await rescueExitDraft(app, draft)).toBe(`${t().rescueFailed('書き込みが許可されていません。')} ${t().rescueDraftKept}`);
  });

  // Review 1: an error without a message was reported as no free name being left.
  it('says the reason is unknown for an error without a message, not that no name is free', async () => {
    const draft = withSource();
    for (const thrown of [new Error(''), 'not an error'] as unknown[]) {
      const vault = new FakeVault();
      vault.create = (path: string): Promise<TFile> => { vault.calls.push(`create ${path}`); throw thrown; };
      const { app } = appWith([draft], vault);
      expect(await rescueExitDraft(app, draft)).toBe(`${t().rescueFailed(t().rescueUnknownReason)} ${t().rescueDraftKept}`);
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
    expect(await rescueExitDraft(app, draft)).toBe(`${t().rescueFailed(t().rescueNoFreeName)} ${t().rescueDraftKept}`);
    expect(vault.calls).toEqual([]);
  });
});

describe('the command 保存できなかった下書きを救出 (LEV-240)', () => {
  it('says there is nothing to rescue when no draft is kept', () => {
    rescueExitDrafts(appWith(null).app);
    expect(Notice.log).toEqual([t().rescueNone]);
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('lists each kept draft with where, when, its title and what it holds', () => {
    rescueExitDrafts(appWith([withSource(), withoutSource(), refused()]).app);
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
    rescueExitDrafts(app);
    buttons()[1]!.click();
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

  it('writes nothing when the confirmation is cancelled', async () => {
    const { app, vault, stored } = appWith([refused()]);
    const before = stored();
    rescueExitDrafts(app);
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
