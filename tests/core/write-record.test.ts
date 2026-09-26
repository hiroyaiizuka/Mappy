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
    const read = record.take(write.after, shown, 'n');
    expect(second(read)).toBe(second(shown));
    // Spent: a later write leads on from the text the reader now shows, not from the end of the old record (code review 2).
    expect(record.size).toBe(0);
  });

  it('keeps a write for the next read when the read found the text on screen (it came before the write)', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    const same = record.take(A, shown, 'n');
    expect(record.take(write.after, same, 'n').nodes.filter(node => node.title === '')[1]?.id).toBe(second(same));
  });

  it('matches an external change by titles from the last text the writes reached, and drops the record', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const write = rename(A, '子1', '改名');
    record.record(write, A);
    const external = write.after.replace('  - 空の子\n', '  - 外から\n');
    const read = record.take(external, shown, 'n');
    // 改名 exists only in the written text: matched from `shown`, it would be a new node.
    const reached = parseMarkdown(write.after, 'n', shown, undefined, write.edits);
    expect(titled(read, '改名')).toBe(titled(reached, '改名'));
    // Dropped: a write on the external text leads on from what the reader now shows.
    const next = rename(external, '改名', 'もう一度');
    record.record(next, read.source);
    expect(second(record.take(next.after, read, 'n'))).toBe(second(read));
  });

  it('spends writes that came back to the text on screen (⌘Z then ⌘⇧Z), so a later write leads on from it', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    const back: RecordedWrite = { before: there.after, after: A, edits: [{ from: there.edits[0]!.from, to: there.edits[0]!.from + 'ずっと長い題名'.length, text: '子1' }] };
    record.record(there, A);
    record.record(back, there.after);
    record.spend(A);
    // Not kept until some later read: each holds two copies of the note (code review 1).
    expect(record.size).toBe(0);
    const next = rename(A, '子1', '別の長い題名');
    record.record(next, A);
    expect(second(record.take(next.after, shown, 'n'))).toBe(second(shown));
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
    const read = record.take(there.after, shown, 'n');
    expect({ size: record.size, second: second(read) }).toEqual({ size: 0, second: second(shown) });
  });

  it('leaves out a write that does not start where the record leads, so it does not block the ones that do', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    record.record(rename(A.replace('子1', '外'), '外', 'ずっと長い題名'), A);
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    expect(second(record.take(write.after, shown, 'n'))).toBe(second(shown));
  });
});
