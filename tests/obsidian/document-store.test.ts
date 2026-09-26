import { describe, expect, it, vi } from 'vitest';
import { TFile, type EditorPosition, type EditorTransaction } from 'obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { MarkdownView } from '../mocks/obsidian';

function makeFile(path = 'Note.md'): TFile {
  const file = new TFile();
  file.path = path;
  return file;
}

function makeEditor(initial: string, state = { source: initial }) {
  const offsetToPos = (offset: number): EditorPosition => {
    const lines = state.source.slice(0, offset).split('\n');
    return { line: lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 };
  };
  const transaction = vi.fn((change: EditorTransaction) => {
    const toOffset = (position: EditorPosition): number => {
      const lines = state.source.split('\n');
      let offset = position.ch;
      for (let line = 0; line < position.line; line += 1) offset += (lines[line]?.length ?? 0) + 1;
      return offset;
    };
    const edits = (change.changes ?? []).map((edit) => ({
      from: toOffset(edit.from),
      to: toOffset(edit.to ?? edit.from),
      text: edit.text,
    })).sort((left, right) => right.from - left.from);
    for (const edit of edits) {
      state.source = state.source.slice(0, edit.from) + edit.text + state.source.slice(edit.to);
    }
  });
  return { state, getValue: () => state.source, offsetToPos, transaction };
}

function harness(initial = '# Before\n', file = makeFile()) {
  const disk = new Map([[file.path, initial]]);
  const leaves: { view: unknown }[] = [];
  const read = vi.fn((target: TFile) => Promise.resolve(disk.get(target.path) ?? ''));
  const process = vi.fn((target: TFile, transform: (source: string) => string) => {
    const source = transform(disk.get(target.path) ?? '');
    disk.set(target.path, source);
    return Promise.resolve(source);
  });
  const store = new DocumentStore({
    workspace: { getLeavesOfType: () => leaves },
    vault: { read, process },
  });
  return { store, file, disk, leaves, read, process };
}

describe('DocumentStore', () => {
  it('reads unsaved Markdown editor text instead of stale disk text', async () => {
    const { store, file, leaves, read } = harness();
    leaves.push({ view: new MarkdownView(file, makeEditor('# Unsaved\n')) });
    expect(await store.read(file)).toBe('# Unsaved\n');
    expect(read).not.toHaveBeenCalled();
  });

  it('uses a newly opened editor if it appears while a disk read is pending', async () => {
    const { store, file, leaves, read } = harness();
    read.mockImplementationOnce(() => {
      leaves.push({ view: new MarkdownView(file, makeEditor('# New buffer\n')) });
      return Promise.resolve('# Before\n');
    });
    expect(await store.read(file)).toBe('# New buffer\n');
  });

  it('ignores deferred views and editors for other files', async () => {
    const { store, file, leaves, read } = harness();
    leaves.push({ view: {} }, { view: new MarkdownView(makeFile('Other.md'), makeEditor('Other')) });
    expect(await store.read(file)).toBe('# Before\n');
    expect(read).toHaveBeenCalledWith(file);
  });

  it('rejects disagreeing open editor buffers without writing either one', async () => {
    const { store, file, leaves, process } = harness();
    const first = makeEditor('# First\n');
    const second = makeEditor('# Second\n');
    leaves.push({ view: new MarkdownView(file, first) }, { view: new MarkdownView(file, second) });
    await expect(store.apply(file, '# First\n', [{ from: 2, to: 7, text: 'Edited' }])).rejects.toThrow('一致しません');
    expect(first.transaction).not.toHaveBeenCalled();
    expect(second.transaction).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('applies a range transaction to open editors and preserves surrounding text', async () => {
    const initial = '# 講座\n\n## Before\nbody [[Link]]\n';
    const { store, file, leaves, process } = harness(initial);
    const editor = makeEditor(initial);
    leaves.push({ view: new MarkdownView(file, editor) });
    const from = initial.indexOf('Before');
    const next = await store.apply(file, initial, [{ from, to: from + 6, text: 'After' }]);
    expect(next).toBe('# 講座\n\n## After\nbody [[Link]]\n');
    expect(editor.transaction).toHaveBeenCalledWith({
      changes: [{ from: { line: 2, ch: 3 }, to: { line: 2, ch: 9 }, text: 'After' }],
    }, 'mappy');
    expect(process).not.toHaveBeenCalled();
  });

  it('updates independent equal buffers and avoids double-editing a shared buffer', async () => {
    const { store, file, leaves } = harness('abc');
    const shared = { source: 'abc' };
    const first = makeEditor('abc', shared);
    const second = makeEditor('abc', shared);
    const independent = makeEditor('abc');
    leaves.push(
      { view: new MarkdownView(file, first) },
      { view: new MarkdownView(file, second) },
      { view: new MarkdownView(file, independent) },
    );
    expect(await store.apply(file, 'abc', [{ from: 1, to: 1, text: '!' }])).toBe('a!bc');
    expect(first.transaction).toHaveBeenCalledTimes(1);
    expect(second.transaction).not.toHaveBeenCalled();
    expect(independent.state.source).toBe('a!bc');
  });

  it('keeps its history when UI queries it synchronously during an editor transaction', async () => {
    const { store, file, leaves } = harness('a');
    const editor = makeEditor('a');
    leaves.push({ view: new MarkdownView(file, editor) });
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    const implementation = editor.transaction.getMockImplementation();
    editor.transaction.mockImplementation((change) => {
      implementation?.(change);
      store.canUndo(file);
    });
    await store.apply(file, 'ab', [{ from: 2, to: 2, text: 'c' }]);
    expect(await store.undo(file)).toBe('ab');
    expect(await store.undo(file)).toBe('a');
  });

  it('checks disk source inside Vault.process and preserves a concurrent external edit', async () => {
    const { store, file, disk, process } = harness();
    process.mockImplementationOnce((target, transform) => {
      disk.set(target.path, '# External\n');
      return Promise.resolve(transform('# External\n'));
    });
    await expect(store.apply(file, '# Before\n', [{ from: 2, to: 8, text: 'After' }])).rejects.toThrow('Markdown が変更');
    expect(disk.get(file.path)).toBe('# External\n');
    expect(store.canUndo(file)).toBe(false);
  });

  it('refuses a disk write if an editor opens before the process callback', async () => {
    const { store, file, leaves, process, disk } = harness();
    process.mockImplementationOnce((_target, transform) => {
      leaves.push({ view: new MarkdownView(file, makeEditor('# Unsaved\n')) });
      return Promise.resolve(transform('# Before\n'));
    });
    await expect(store.apply(file, '# Before\n', [{ from: 2, to: 8, text: 'After' }])).rejects.toThrow('保存中');
    expect(disk.get(file.path)).toBe('# Before\n');
  });

  it('serializes same-file commands and recovers its queue after a stale command', async () => {
    const { store, file, disk } = harness('a');
    const first = store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    const stale = store.apply(file, 'a', [{ from: 1, to: 1, text: 'x' }]);
    const last = store.apply(file, 'ab', [{ from: 2, to: 2, text: 'c' }]);
    await expect(first).resolves.toBe('ab');
    await expect(stale).rejects.toThrow('Markdown が変更');
    await expect(last).resolves.toBe('abc');
    expect(disk.get(file.path)).toBe('abc');
  });

  it('undoes and redoes multiple disjoint edits using inverse offsets', async () => {
    const { store, file, disk } = harness('alpha beta gamma');
    const after = await store.apply(file, 'alpha beta gamma', [
      { from: 11, to: 16, text: 'G' },
      { from: 0, to: 5, text: 'ALPHABET' },
    ]);
    expect(after).toBe('ALPHABET beta G');
    expect(store.canUndo(file)).toBe(true);
    expect(await store.undo(file)).toBe('alpha beta gamma');
    expect(store.canRedo(file)).toBe(true);
    expect(await store.redo(file)).toBe(after);
    expect(disk.get(file.path)).toBe(after);
  });

  it('merges adjacent deletions so their inverse does not contain duplicate insert offsets', async () => {
    const { store, file } = harness('abcdef');
    expect(await store.apply(file, 'abcdef', [
      { from: 1, to: 3, text: '' }, { from: 3, to: 5, text: '' },
    ])).toBe('af');
    expect(await store.undo(file)).toBe('abcdef');
    expect(await store.redo(file)).toBe('af');
  });

  it('discards unsafe history after an external edit, including editor-side undo', async () => {
    const { store, file, disk } = harness('a');
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    disk.set(file.path, 'External');
    await expect(store.undo(file)).rejects.toThrow('Markdown が変更');
    expect(disk.get(file.path)).toBe('External');
    expect(store.canUndo(file)).toBe(false);
    expect(store.canRedo(file)).toBe(false);

    const editor = makeEditor('External');
    const fixture = harness('External');
    fixture.leaves.push({ view: new MarkdownView(fixture.file, editor) });
    await fixture.store.apply(fixture.file, 'External', [{ from: 8, to: 8, text: '!' }]);
    editor.state.source = 'External';
    expect(fixture.store.canUndo(fixture.file)).toBe(false);
  });

  it('drops redo after a new edit and treats identical replacements as no-ops', async () => {
    const { store, file, process } = harness('a');
    await store.apply(file, 'a', [{ from: 0, to: 1, text: 'a' }]);
    expect(store.canUndo(file)).toBe(false);
    expect(process).not.toHaveBeenCalled();
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    await store.undo(file);
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'c' }]);
    expect(store.canRedo(file)).toBe(false);
    expect(await store.redo(file)).toBe('ac');
  });

  it('keeps histories separate for different files and caps each at 50 operations', async () => {
    const { store, file, disk } = harness('0');
    const other = makeFile('Other.md');
    disk.set(other.path, 'Other');
    await store.apply(other, 'Other', [{ from: 5, to: 5, text: '!' }]);
    for (let index = 0; index < 51; index += 1) {
      await store.apply(file, String(index), [{ from: 0, to: String(index).length, text: String(index + 1) }]);
    }
    for (let index = 0; index < 50; index += 1) await store.undo(file);
    expect(await store.read(file)).toBe('1');
    expect(store.canUndo(file)).toBe(false);
    expect(await store.undo(other)).toBe('Other');
  });

  describe('applyLatest (a layout button, LEV-196)', () => {
    const HEADER = '---\nmappy: true\n---\n';
    const addHeader = () => [{ from: 0, to: 0, text: HEADER }];

    it('plans on the text as it is when its turn comes, behind an edit already queued', async () => {
      const { store, file, disk } = harness('# A\n');
      await store.read(file);
      const edit = store.apply(file, '# A\n', [{ from: 2, to: 3, text: 'B' }]);
      const seen: string[] = [];
      const layout = store.applyLatest(file, source => { seen.push(source); return addHeader(); });
      await expect(edit).resolves.toBe('# B\n');
      await expect(layout).resolves.toEqual({ before: '# B\n', after: `${HEADER}# B\n`, edits: addHeader() });
      expect(seen).toEqual(['# B\n']);
      expect(disk.get(file.path)).toBe(`${HEADER}# B\n`);
    });

    it('is no step of the history, and drops the steps before it as any change the history did not make', async () => {
      const { store, file } = harness('# A\n');
      await store.apply(file, '# A\n', [{ from: 2, to: 3, text: 'B' }]);
      expect(store.canUndo(file)).toBe(true);
      await store.applyLatest(file, addHeader);
      expect(store.canUndo(file)).toBe(false);
      // An edit after it is measured against it and is undone on its own.
      await store.apply(file, `${HEADER}# B\n`, [{ from: HEADER.length + 2, to: HEADER.length + 3, text: 'C' }]);
      await expect(store.undo(file)).resolves.toBe(`${HEADER}# B\n`);
    });

    it('writes nothing and keeps the history when the plan changes nothing', async () => {
      const { store, file, process } = harness('# A\n');
      await store.apply(file, '# A\n', [{ from: 2, to: 3, text: 'B' }]);
      process.mockClear();
      await expect(store.applyLatest(file, () => [])).resolves.toEqual({ before: '# B\n', after: '# B\n', edits: [] });
      expect(process).not.toHaveBeenCalled();
      expect(store.canUndo(file)).toBe(true);
    });

    it('goes through an open editor, as every write of an open note does', async () => {
      const { store, file, leaves, process } = harness('# A\n');
      const editor = makeEditor('# A\n');
      leaves.push({ view: new MarkdownView(file, editor) });
      await store.applyLatest(file, addHeader);
      expect(editor.state.source).toBe(`${HEADER}# A\n`);
      expect(process).not.toHaveBeenCalled();
    });
  });
});
