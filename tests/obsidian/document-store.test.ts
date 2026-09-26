import { describe, expect, it, vi } from 'vitest';
import { TFile, type EditorPosition, type EditorTransaction } from 'obsidian';
import { DocumentStore, conflictMessage } from '../../src/obsidian/document-store';
import { MarkdownView } from '../mocks/obsidian';
import { planMapLayout } from '../../src/core/layout-key';

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

  it('retracts its last write with no step left for Undo or Redo, the steps before it kept (LEV-203)', async () => {
    const { store, file, disk } = harness('a');
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    const added = await store.applyOver(file, 'ab', [{ from: 2, to: 2, text: 'c' }]);
    const back = await store.retract(file, added);
    expect(back).toEqual({ before: 'abc', after: 'ab', edits: [{ from: 2, to: 3, text: '' }] });
    expect(disk.get(file.path)).toBe('ab');
    expect(store.canRedo(file)).toBe(false);
    expect(await store.undo(file)).toBe('a');
    expect(store.canUndo(file)).toBe(false);
    expect(await store.redo(file)).toBe('ab');
    expect(store.canRedo(file)).toBe(false);
  });

  it('gives back the Redo steps the retracted write dropped', async () => {
    const { store, file } = harness('a');
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    await store.undo(file);
    expect(store.canRedo(file)).toBe(true);
    const added = await store.applyOver(file, 'a', [{ from: 1, to: 1, text: 'c' }], { retractable: true });
    expect(store.canRedo(file)).toBe(false);
    await store.retract(file, added);
    expect(await store.redo(file)).toBe('ab');
    // Only a retractable write keeps them: any other lets them go at once (review 2: they hold whole notes).
    await store.undo(file);
    const plain = await store.applyOver(file, 'a', [{ from: 1, to: 1, text: 'd' }]);
    await store.retract(file, plain);
    expect(store.canRedo(file)).toBe(false);
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    await store.undo(file);
    // Only the last step keeps them: once another step has followed, they are gone as after any edit, and the Redo
    // left by undoing that later step (planned on the retracted text) goes with the retract.
    await store.undo(file);
    const first = await store.applyOver(file, 'a', [{ from: 1, to: 1, text: 'x' }], { retractable: true });
    await store.apply(file, 'ax', [{ from: 2, to: 2, text: 'y' }]);
    await store.undo(file);
    await expect(store.retract(file, first)).resolves.toEqual({ before: 'ax', after: 'a', edits: [{ from: 1, to: 2, text: '' }] });
    expect(store.canRedo(file)).toBe(false);
  });

  it('lets the dropped Redo steps go once a write that changes nothing has come after (review 3)', async () => {
    const { store, file } = harness('a');
    await store.apply(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    await store.undo(file);
    const added = await store.applyOver(file, 'a', [{ from: 1, to: 1, text: 'c' }], { retractable: true });
    await store.apply(file, 'ac', [{ from: 1, to: 2, text: 'c' }]);
    await store.retract(file, added);
    expect(store.canRedo(file)).toBe(false);
  });

  it('retracts through an open editor', async () => {
    const editor = makeEditor('a');
    const { store, file, leaves } = harness('a');
    leaves.push({ view: new MarkdownView(file, editor) });
    const added = await store.applyOver(file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    await store.retract(file, added);
    expect(editor.state.source).toBe('a');
    expect(store.canUndo(file)).toBe(false);
  });

  it('refuses to retract a write something came after, leaving the note as it is', async () => {
    const own = harness('a');
    const first = await own.store.applyOver(own.file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    await own.store.apply(own.file, 'ab', [{ from: 2, to: 2, text: 'c' }]);
    await expect(own.store.retract(own.file, first)).rejects.toThrow(conflictMessage);
    expect(own.disk.get(own.file.path)).toBe('abc');
    // The later step is still there to undo.
    expect(await own.store.undo(own.file)).toBe('ab');

    const external = harness('a');
    const added = await external.store.applyOver(external.file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    external.disk.set(external.file.path, 'ab!');
    await expect(external.store.retract(external.file, added)).rejects.toThrow(conflictMessage);
    expect(external.disk.get(external.file.path)).toBe('ab!');
    expect(external.store.canUndo(external.file)).toBe(false);

    const undone = harness('a');
    const gone = await undone.store.applyOver(undone.file, 'a', [{ from: 1, to: 1, text: 'b' }]);
    await undone.store.undo(undone.file);
    await expect(undone.store.retract(undone.file, gone)).rejects.toThrow(conflictMessage);
    expect(undone.disk.get(undone.file.path)).toBe('a');
    expect(undone.store.canRedo(undone.file)).toBe(true);
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

    it('is no step of the history, and carries the steps before and after it over it (LEV-206)', async () => {
      const MAP = '---\nmappy: true\n---\n';
      const TIMELINE = '---\nmappy: true\nmappy-layout: timeline\n---\n';
      const { store, file, disk } = harness(`${MAP}# A\n`);
      await store.apply(file, `${MAP}# A\n`, [{ from: MAP.length + 2, to: MAP.length + 3, text: 'B' }]);
      await store.apply(file, `${MAP}# B\n`, [{ from: MAP.length + 2, to: MAP.length + 3, text: 'C' }]);
      await store.undo(file);
      const timeline = (source: string) => planMapLayout(source, 'timeline');
      await expect(store.applyLatest(file, timeline)).resolves.toMatchObject({ after: `${TIMELINE}# B\n` });
      expect(store.canUndo(file)).toBe(true);
      expect(store.canRedo(file)).toBe(true);
      // The switch itself is no step: Redo and Undo walk the edits, each text keeping the layout.
      await expect(store.redo(file)).resolves.toBe(`${TIMELINE}# C\n`);
      await expect(store.undo(file)).resolves.toBe(`${TIMELINE}# B\n`);
      await expect(store.undo(file)).resolves.toBe(`${TIMELINE}# A\n`);
      expect(store.canUndo(file)).toBe(false);
      expect(disk.get(file.path)).toBe(`${TIMELINE}# A\n`);
      await expect(store.redo(file)).resolves.toBe(`${TIMELINE}# B\n`);
      await expect(store.redo(file)).resolves.toBe(`${TIMELINE}# C\n`);
      expect(store.canRedo(file)).toBe(false);
    });

    it('keeps the steps across several switches, and an edit after one is undone on its own', async () => {
      const MAP = '---\nmappy: true\n---\n';
      const { store, file } = harness(`${MAP}# A\n`);
      await store.apply(file, `${MAP}# A\n`, [{ from: MAP.length + 2, to: MAP.length + 3, text: 'B' }]);
      await store.applyLatest(file, (source) => planMapLayout(source, 'timeline'));
      const TIMELINE = '---\nmappy: true\nmappy-layout: timeline\n---\n';
      await store.apply(file, `${TIMELINE}# B\n`, [{ from: TIMELINE.length + 2, to: TIMELINE.length + 3, text: 'C' }]);
      await store.applyLatest(file, (source) => planMapLayout(source, 'hierarchy'));
      const HIERARCHY = '---\nmappy: true\nmappy-layout: hierarchy\n---\n';
      await expect(store.undo(file)).resolves.toBe(`${HIERARCHY}# B\n`);
      await expect(store.undo(file)).resolves.toBe(`${HIERARCHY}# A\n`);
      await store.applyLatest(file, (source) => planMapLayout(source, 'mindmap'));
      await expect(store.redo(file)).resolves.toBe(`${MAP}# B\n`);
      await expect(store.redo(file)).resolves.toBe(`${MAP}# C\n`);
    });

    it('carries a step that wrote beside the layout line, and one that made the note a map', async () => {
      const MAP = '---\nmappy: true\n---\n';
      const { store, file } = harness('# A\n');
      // A step that wrote the frontmatter, then one that inserted a key where the layout line goes.
      await store.apply(file, '# A\n', [{ from: 0, to: 0, text: MAP }]);
      await store.apply(file, `${MAP}# A\n`, [{ from: 16, to: 16, text: 'mappy-topics: []\n' }]);
      await store.applyLatest(file, (source) => planMapLayout(source, 'timeline'));
      await expect(store.undo(file)).resolves.toBe('---\nmappy: true\nmappy-layout: timeline\n---\n# A\n');
      // Before the note was a map there was no layout to keep.
      await expect(store.undo(file)).resolves.toBe('# A\n');
      await expect(store.redo(file)).resolves.toBe('---\nmappy: true\nmappy-layout: timeline\n---\n# A\n');
      await expect(store.redo(file)).resolves.toBe('---\nmappy: true\nmappy-topics: []\nmappy-layout: timeline\n---\n# A\n');
    });

    it('hands an open editor the step\'s own edits, not one replace from the first to the last', async () => {
      const MAP = '---\nmappy: true\n---\n';
      const initial = `${MAP}# A\n- b\n`;
      const { store, file, leaves } = harness(initial);
      const editor = makeEditor(initial);
      leaves.push({ view: new MarkdownView(file, editor) });
      // A key written where the layout line goes, and a rename far below it, in one step.
      await store.apply(file, initial, [{ from: 16, to: 16, text: 'mappy-topics: []\n' }, { from: initial.length - 2, to: initial.length - 1, text: 'c' }]);
      await store.applyLatest(file, (source) => planMapLayout(source, 'timeline'));
      editor.transaction.mockClear();
      await expect(store.undo(file)).resolves.toBe('---\nmappy: true\nmappy-layout: timeline\n---\n# A\n- b\n');
      expect(editor.transaction.mock.calls[0]?.[0].changes).toHaveLength(2);
      await expect(store.redo(file)).resolves.toBe('---\nmappy: true\nmappy-topics: []\nmappy-layout: timeline\n---\n# A\n- c\n');
    });

    it('makes a step that touched the layout line\'s place the one edit between its texts, not splitting a character', async () => {
      const initial = '---\nmappy: true\n---\n# 😀\n';
      const { store, file, leaves } = harness(initial);
      const editor = makeEditor(initial);
      leaves.push({ view: new MarkdownView(file, editor) });
      // One edit over the header's end and the title: the layout line lands inside what it replaced.
      await store.apply(file, initial, [{ from: 4, to: 24, text: 'mappy: true\n---\n# 😃' }]);
      await store.applyLatest(file, (source) => planMapLayout(source, 'timeline'));
      editor.transaction.mockClear();
      await expect(store.undo(file)).resolves.toBe('---\nmappy: true\nmappy-layout: timeline\n---\n# 😀\n');
      // The two texts differ in the emoji's second half only; the edit starts at the emoji, not inside it.
      expect(editor.transaction.mock.calls[0]?.[0].changes).toEqual([{ from: { line: 4, ch: 2 }, to: { line: 4, ch: 4 }, text: '😀' }]);
      await expect(store.redo(file)).resolves.toBe('---\nmappy: true\nmappy-layout: timeline\n---\n# 😃\n');
    });

    // Pins the fail-safe, not the fix: before LEV-206 every step went at the write, so this passes there too.
    it('drops the whole stack, and writes nothing, when the plan cannot plan on the step Undo reaches', async () => {
      const { store, file, disk } = harness('# A\n');
      await store.apply(file, '# A\n', [{ from: 2, to: 3, text: 'B' }]);
      const plan = (source: string) => {
        if (source !== '# B\n') throw new Error('not this text');
        return [{ from: 0, to: 0, text: '---\nmappy: true\n---\n' }];
      };
      await expect(store.applyLatest(file, plan)).resolves.toMatchObject({ after: '---\nmappy: true\n---\n# B\n' });
      await expect(store.undo(file)).resolves.toBe('---\nmappy: true\n---\n# B\n');
      expect(disk.get(file.path)).toBe('---\nmappy: true\n---\n# B\n');
      expect(store.canUndo(file)).toBe(false);
    });

    it('carries nothing until Undo or Redo reaches a step: a switch does not plan on the history', async () => {
      const MAP = '---\nmappy: true\n---\n';
      const { store, file } = harness(`${MAP}# A\n`);
      await store.apply(file, `${MAP}# A\n`, [{ from: MAP.length + 2, to: MAP.length + 3, text: 'B' }]);
      const seen: string[] = [];
      await store.applyLatest(file, (source) => { seen.push(source); return planMapLayout(source, 'timeline'); });
      expect(seen).toEqual([`${MAP}# B\n`]);
      await expect(store.undo(file)).resolves.toBe('---\nmappy: true\nmappy-layout: timeline\n---\n# A\n');
    });

    it('drops a step made before more switches than it keeps the plans of', async () => {
      const MAP = '---\nmappy: true\n---\n';
      const { store, file } = harness(`${MAP}# A\n`);
      await store.apply(file, `${MAP}# A\n`, [{ from: MAP.length + 2, to: MAP.length + 3, text: 'B' }]);
      for (let index = 0; index < 17; index += 1) {
        await store.applyLatest(file, (source) => planMapLayout(source, index % 2 === 0 ? 'timeline' : 'mindmap'));
      }
      const current = await store.read(file);
      await expect(store.undo(file)).resolves.toBe(current);
      expect(store.canUndo(file)).toBe(false);
    });

    // Pins E05, which LEV-206 leaves as it was: this passes before the fix too.
    it('still drops the steps at a change from outside after it (E05)', async () => {
      const MAP = '---\nmappy: true\n---\n';
      const { store, file, disk } = harness(`${MAP}# A\n`);
      await store.apply(file, `${MAP}# A\n`, [{ from: MAP.length + 2, to: MAP.length + 3, text: 'B' }]);
      await store.applyLatest(file, (source) => planMapLayout(source, 'timeline'));
      disk.set(file.path, `${disk.get(file.path) ?? ''}- 外から\n`);
      await store.read(file);
      expect(store.canUndo(file)).toBe(false);
      await expect(store.undo(file)).resolves.toBe(disk.get(file.path));
    });

    it('carries an edit planned before it over it, and says what it wrote', async () => {
      const { store, file, disk } = harness('---\nmappy: true\n---\n# A\n');
      await store.read(file);
      const layout = [{ from: 16, to: 16, text: 'mappy-layout: timeline\n' }];
      await store.applyLatest(file, () => layout);
      const planned = [{ from: 22, to: 23, text: 'B' }];
      await expect(store.applies(file, '---\nmappy: true\n---\n# A\n')).resolves.toBe(true);
      await expect(store.applyOver(file, '---\nmappy: true\n---\n# A\n', planned)).resolves.toEqual({
        before: '---\nmappy: true\nmappy-layout: timeline\n---\n# A\n',
        after: '---\nmappy: true\nmappy-layout: timeline\n---\n# B\n',
        edits: [{ from: 45, to: 46, text: 'B' }],
        carried: [{ before: '---\nmappy: true\n---\n# A\n', after: '---\nmappy: true\nmappy-layout: timeline\n---\n# A\n', edits: layout }],
      });
      expect(disk.get(file.path)).toBe('---\nmappy: true\nmappy-layout: timeline\n---\n# B\n');
      // Spent: an edit planned before it again is planned before this edit too, and is refused.
      await expect(store.apply(file, '---\nmappy: true\n---\n# A\n', planned)).rejects.toThrow(conflictMessage);
    });

    it('refuses as before an edit that touches its lines, and one planned before someone else\'s change', async () => {
      const { store, file, disk } = harness('---\nmappy: true\n---\n# A\n');
      await store.read(file);
      await store.applyLatest(file, () => [{ from: 16, to: 16, text: 'mappy-layout: timeline\n' }]);
      await expect(store.apply(file, '---\nmappy: true\n---\n# A\n', [{ from: 4, to: 20, text: '' }])).rejects.toThrow(conflictMessage);
      disk.set(file.path, `${disk.get(file.path) ?? ''}- 外から\n`);
      await expect(store.applies(file, '---\nmappy: true\n---\n# A\n')).resolves.toBe(false);
      await expect(store.apply(file, '---\nmappy: true\n---\n# A\n', [{ from: 22, to: 23, text: 'B' }])).rejects.toThrow(conflictMessage);
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
