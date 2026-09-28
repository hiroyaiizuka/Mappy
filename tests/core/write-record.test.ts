/**
 * The record of the store's writes that a map embed (LEV-217), the maps an item calls (LEV-221) and the map tab (LEV-247)
 * keep. The embed's own rows are in
 * tests/ui/map-embed-own-writes.test.ts; these pin the cases a re-read there reaches only through timing: a read that
 * comes before a write the record holds, an external change after a write, writes that come back to the text on
 * screen (code review 1 of LEV-217).
 */
import { describe, expect, it } from 'vitest';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';
import { WriteRecord, type RecordedWrite } from '../../src/core/write-record';

const A = ['---', 'mappy: true', '---', '- 親', '  - 子1', '- ', '  - 空の子', '- ', '  - 空の子2', ''].join('\n');

function rename(before: string, from: string, to: string): RecordedWrite {
  const at = before.indexOf(from);
  return { before, after: before.slice(0, at) + to + before.slice(at + from.length), edits: [{ from: at, to: at + from.length, text: to }] };
}

/** The id of the second untitled node, the one only the edits can carry. */
const second = (document: MindDocument): string | undefined => document.nodes.filter(node => node.title === '')[1]?.id;
/** The id of the node titled `title`. */
const titled = (document: MindDocument, title: string): string | undefined => document.nodes.find(node => node.title === title)?.id;

describe('WriteRecord', () => {
  it('carries the ids through the writes that lead to the text read, and spends them', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    const read = record.take(write.after, shown, 'n', record.mark());
    expect(second(read)).toBe(second(shown));
    // Spent: a later write leads on from the text the reader now shows, not from the end of the old record (code review 2).
    expect(record.size).toBe(0);
  });

  it('keeps a write for the next read when the read found the text on screen (it came before the write)', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    const reading = record.mark();
    record.record(write, A);
    const same = record.take(A, shown, 'n', reading);
    expect(record.take(write.after, same, 'n', record.mark()).nodes.filter(node => node.title === '')[1]?.id).toBe(second(same));
  });

  // LEV-224: a read of the text on screen keeps only the writes recorded while it was under way. One recorded before it
  // began was there for the read to find: the text on screen found instead means the note was put back, and kept, the
  // write would stand at the end of the record where the next write, made on the text on screen, could not follow it.
  it.each([
    ['take', (record: WriteRecord, shown: MindDocument, mark: number) => { record.take(A, shown, 'n', mark); }],
    ['spend', (record: WriteRecord, _shown: MindDocument, mark: number) => { record.spend(A, mark); }],
  ] as const)('%s: drops a write recorded before a read that found the text on screen (the note put back)', (_name, read) => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    record.record(rename(A, '子1', 'ずっと長い題名'), A);
    read(record, shown, record.mark());
    expect(record.size).toBe(0);
    const next = rename(A, '- \n', '- 命名\n');
    record.record(next, A);
    expect(record.size).toBe(1);
  });

  it('keeps, of the writes recorded while a read of the text on screen was under way, only those that lead on from it', () => {
    // W1 (A→X) recorded before the read, W2 (X→Y) while it reads, and the read finds A: W1 goes, and W2 with it — kept,
    // it would start the record at X, a text the reader does not show, and no write on A could follow it.
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    record.record(there, A);
    const reading = record.mark();
    record.record(rename(there.after, 'ずっと長い題名', '別'), A);
    record.spend(A, reading);
    expect(record.size).toBe(0);
  });

  // Not a regression test of LEV-224 (it holds before the fix, which kept every write): it pins that the fix does not
  // drop too much — a write recorded while the read was under way is the next read's to carry.
  it('keeps the writes recorded while a read of the text on screen was under way that lead on from it', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const reading = record.mark();
    const there = rename(A, '子1', 'ずっと長い題名');
    const on = rename(there.after, '- \n', '- 命名\n');
    record.record(there, A);
    record.record(on, A);
    record.spend(A, reading);
    expect(record.size).toBe(2);
    expect(record.take(on.after, shown, 'n', record.mark()).nodes.filter(node => node.title === '')[0]?.id).toBe(second(shown));
  });

  // Code review 1 of LEV-224: a read that reaches part of the record spent it and kept the rest whole, so a write after
  // the one it reached, recorded before it began and put back, stood at the end of the record all the same.
  it('take: drops, past the write a read reached, a write recorded before the read began (put back)', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    record.record(there, A);
    record.record(rename(there.after, '親', '改名'), A);
    const read = record.take(there.after, shown, 'n', record.mark());
    expect({ size: record.size, second: second(read) }).toEqual({ size: 0, second: second(shown) });
  });

  it('spend: drops, past the writes that came back to the text on screen, a write recorded before the read began', () => {
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    const back: RecordedWrite = { before: there.after, after: A, edits: [{ from: there.edits[0]!.from, to: there.edits[0]!.from + 'ずっと長い題名'.length, text: '子1' }] };
    record.record(there, A);
    record.record(back, A);
    record.record(rename(A, '親', '改名'), A);
    record.spend(A, record.mark());
    expect(record.size).toBe(0);
  });

  // Not a regression test either (it holds before code review 1, which kept the rest whole): it pins that dropping past
  // the write a read reached does not drop a write recorded while the read was under way.
  it('keeps, past the write a read reached, the writes recorded while it was under way that lead on from the text', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    record.record(there, A);
    const reading = record.mark();
    const on = rename(there.after, '- \n', '- 命名\n');
    record.record(on, A);
    const read = record.take(there.after, shown, 'n', reading);
    expect(record.size).toBe(1);
    expect(record.take(on.after, read, 'n', record.mark()).nodes.filter(node => node.title === '')[0]?.id).toBe(second(shown));
  });

  it('starts the record again with a write on the text on screen while it ends elsewhere (the note was put back)', () => {
    // A write read on the text last parsed: the store wrote on that text, so the writes recorded were taken back.
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    record.record(rename(A, '子1', 'ずっと長い題名'), A);
    const next = rename(A, '- \n', '- 命名\n');
    record.record(next, A);
    expect(record.size).toBe(1);
    const read = record.take(next.after, shown, 'n', record.mark());
    expect(read.nodes.filter(node => node.title === '')[0]?.id).toBe(second(shown));
  });

  it('matches an external change by titles from the last text the writes reached, and drops the record', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const write = rename(A, '子1', '改名');
    record.record(write, A);
    const external = write.after.replace('  - 空の子\n', '  - 外から\n');
    const read = record.take(external, shown, 'n', record.mark());
    // 改名 exists only in the written text: matched from `shown`, it would be a new node.
    const reached = parseMarkdown(write.after, 'n', shown, undefined, write.edits);
    expect(titled(read, '改名')).toBe(titled(reached, '改名'));
    // Dropped: a write on the external text leads on from what the reader now shows.
    const next = rename(external, '改名', 'もう一度');
    record.record(next, read.source);
    expect(second(record.take(next.after, read, 'n', record.mark()))).toBe(second(read));
  });

  it('spends writes that came back to the text on screen (⌘Z then ⌘⇧Z), so a later write leads on from it', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    const back: RecordedWrite = { before: there.after, after: A, edits: [{ from: there.edits[0]!.from, to: there.edits[0]!.from + 'ずっと長い題名'.length, text: '子1' }] };
    record.record(there, A);
    record.record(back, there.after);
    record.spend(A, record.mark());
    // Not kept until some later read: each holds two copies of the note (code review 1).
    expect(record.size).toBe(0);
    const next = rename(A, '子1', '別の長い題名');
    record.record(next, A);
    expect(second(record.take(next.after, shown, 'n', record.mark()))).toBe(second(shown));
  });

  it('spends every write up to the last one that wrote the text read (a rename, ⌘Z, ⌘⇧Z before one re-read)', () => {
    // Code review 3: stopping at the first one left ⌘Z and ⌘⇧Z behind, held until some later write.
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    const back: RecordedWrite = { before: there.after, after: A, edits: [{ from: there.edits[0]!.from, to: there.edits[0]!.from + 'ずっと長い題名'.length, text: '子1' }] };
    record.record(there, A);
    record.record(back, there.after);
    record.record(there, A);
    const read = record.take(there.after, shown, 'n', record.mark());
    expect({ size: record.size, second: second(read) }).toEqual({ size: 0, second: second(shown) });
  });

  // LEV-247: the view's record is this one. What only the view needs was its own (`recordOwn`, `recordCarried`, `reread`,
  // `showOwnWrite`, `parseOwn`) and is pinned from the view too (tests/ui/mindmap-view-reread-own-writes.test.ts,
  // mindmap-view-undo-ids.test.ts); these pin it where it now lives: the store's answer heard after its word (`confirm`),
  // the writes an edit was carried over (`carry`), a replay that spends nothing and parses a write once per base
  // (`replay`), and the version a read tells a replaced record by.
  it('record: leaves out a write that changed nothing, which takes nothing back', () => {
    // Fails on the record before LEV-247, which took it for a put-back and started again from it.
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    record.record({ before: A, after: A, edits: [] }, A);
    expect(record.recorded).toEqual([write]);
  });

  it('record: starts again with a write on the text on screen even when the record holds the same write', () => {
    // The store tells each write once: the same write again was made again, after the note was put back.
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    record.record(rename(write.after, '親', '改名'), A);
    const again = { ...write, edits: write.edits.map(edit => ({ ...edit })) };
    record.record(again, A);
    expect(record.recorded).toEqual([again]);
    expect(record.recorded[0]).toBe(again);
  });

  it('confirm: the store\'s answer to a write its word told already is not recorded again', () => {
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    const other = rename(write.after, '親', '改名');
    record.record(write, A);
    record.confirm({ ...write }, A);
    expect(record.recorded).toEqual([write]);
    // Nor when others were recorded after it and it starts on the text on screen.
    record.record(other, A);
    record.confirm({ ...write }, A);
    expect(record.recorded).toEqual([write, other]);
    // Nor once a read has spent it (its start is behind the text on screen).
    record.clear();
    record.confirm(other, other.after);
    expect(record.size).toBe(0);
  });

  it('confirm: a write the store\'s word did not record, and a write of the same texts with other edits, are recorded', () => {
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    // The answer carries the writes the edit was carried over too (`CarriedWrite.carried`): only the write is kept.
    record.confirm({ ...write, carried: [write] } as RecordedWrite, A);
    expect(record.recorded).toEqual([write]);
    const twin = rename(A, '- \n  - 空の子\n', '');
    const other = { ...twin, edits: [{ from: twin.edits[0]!.from + 1, to: twin.edits[0]!.to + 1, text: '' }] };
    record.record(twin, A);
    record.confirm(other, A);
    expect(record.recorded).toEqual([other]);
  });

  it('carry: records the writes an edit was carried over where the record leads, and parses the plan through them', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const layout = rename(A, 'mappy: true', 'mappy: true\nmappy-layout: timeline');
    const stray = rename(A.replace('子1', '外'), '外', '別');
    const base = record.carry([stray, layout], A, shown, 'n');
    expect(record.recorded).toEqual([layout]);
    expect(base?.source).toBe(layout.after);
    expect(second(base!)).toBe(second(shown));
    // Held already: found, not added again, and parsed alike (the same document for the same plan).
    expect(record.carry([layout], A, shown, 'n')).toBe(base);
    expect(record.size).toBe(1);
  });

  it('replay: parses to the last write that wrote the text and spends nothing; the same parse for the same base', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    const back: RecordedWrite = { before: there.after, after: A, edits: [{ from: there.edits[0]!.from, to: there.edits[0]!.from + 'ずっと長い題名'.length, text: '子1' }] };
    const added = rename(A, '  - 子1\n', '  - 子1\n  - 新しい子\n');
    record.record(there, A);
    record.record(back, A);
    record.record(added, A);
    const replayed = record.replay(added.after, shown, 'n');
    expect({ used: replayed?.used, size: record.size }).toEqual({ used: 3, size: 3 });
    // A node the write added keeps the id it got in the first parse: the write shown at once and a draft's base agree.
    expect(titled(record.replay(added.after, shown, 'n')!.document, '新しい子')).toBe(titled(replayed!.document, '新しい子'));
    expect(record.replay('another text', shown, 'n')).toBeUndefined();
  });

  it('keep, drop, clear and a restart change the version; a write added on the end does not', () => {
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    const on = rename(write.after, '親', '改名');
    const versions = [record.version];
    record.record(write, A);
    record.record(on, A);
    versions.push(record.version);
    record.drop(1);
    versions.push(record.version);
    expect(record.recorded).toEqual([on]);
    // [on] ends elsewhere than A: a write on A starts it again.
    record.record(rename(A, '親', '別'), A);
    versions.push(record.version);
    record.keep(A, record.mark(), 0);
    versions.push(record.version);
    record.clear();
    versions.push(record.version);
    expect(versions[1]).toBe(versions[0]);
    expect(new Set(versions.slice(1)).size).toBe(versions.length - 1);
  });

  it('leaves out a write that does not start where the record leads, so it does not block the ones that do', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    record.record(rename(A.replace('子1', '外'), '外', 'ずっと長い題名'), A);
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    expect(second(record.take(write.after, shown, 'n', record.mark()))).toBe(second(shown));
  });
});
