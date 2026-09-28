/**
 * The record a map embed keeps of the store's writes (LEV-217). The embed's own rows are in
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

  it('leaves out a write that does not start where the record leads, so it does not block the ones that do', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    record.record(rename(A.replace('子1', '外'), '外', 'ずっと長い題名'), A);
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    expect(second(record.take(write.after, shown, 'n', record.mark()))).toBe(second(shown));
  });
});
