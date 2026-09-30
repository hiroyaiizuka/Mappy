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

  it('keeps, of the writes recorded while a read of the text on screen was under way, one on a change it did not find', () => {
    // W1 (A→X) recorded before the read, W2 (X→Y) while it reads, and the read finds A: W1 goes (put back), and W2 stays.
    // Until LEV-238 it went with W1: kept, it started the record at X, where no write on A could follow it. Now a write
    // on A starts the record again, and a read of another text matches the change to X by titles and carries W2's edits.
    const record = new WriteRecord();
    const there = rename(A, '子1', 'ずっと長い題名');
    record.record(there, A);
    const reading = record.mark();
    const on = rename(there.after, 'ずっと長い題名', '別');
    record.record(on, A);
    record.spend(A, reading);
    expect(record.recorded).toEqual([on]);
    const next = rename(A, '- \n', '- 命名\n');
    record.record(next, A);
    expect(record.recorded).toEqual([next]);
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
    record.keep(record.mark(), 0);
    versions.push(record.version);
    record.clear();
    versions.push(record.version);
    expect(versions[1]).toBe(versions[0]);
    expect(new Set(versions.slice(1)).size).toBe(versions.length - 1);
  });

  // LEV-238: a write the store made on a text the reader had not read yet — someone changed the note (a sync, the
  // Markdown pane) and the map wrote on it before the reader's re-read — was left out, and the re-read matched every node
  // by titles from the text on screen. A node the write renamed then matched nothing (two changes, so not the single
  // title edit either) and got a new id. Now the write is recorded, and the re-read matches the change it did not see by
  // titles (E05) and carries the ids through the write by its edits.
  const H = ['---', 'mappy: true', '---', '## 履歴', '', '- 親', '  - 子1', '- ', '  - 空の子', '- ', '  - 空の子2', '', '## 別', '', '- 枝', ''].join('\n');
  /** Someone else's change to `text`, away from the nodes the writes touch. */
  const elsewhere = (text: string): string => text.replace('- 枝\n', '- 外から\n');
  /** The id of the first untitled node. */
  const first = (document: MindDocument): string | undefined => document.nodes.filter(node => node.title === '')[0]?.id;

  it('records a write on a text the reader has not read yet, and carries the ids through it after the change before it', () => {
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const write = rename(elsewhere(H), '子1', 'ずっと長い題名');
    record.record(write, H);
    expect(record.recorded).toEqual([write]);
    const read = record.take(write.after, shown, 'n', record.mark());
    expect({ size: record.size, renamed: titled(read, 'ずっと長い題名'), 外から: titled(read, '外から') })
      .toEqual({ size: 0, renamed: titled(shown, '子1'), 外から: titled(shown, '枝') });
  });

  it('records a write after a change that followed a recorded write, and carries the ids through both writes', () => {
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const there = rename(H, '子1', 'ずっと長い題名');
    record.record(there, H);
    const write = rename(elsewhere(there.after), '- 親', '- 改名');
    record.record(write, H);
    expect(record.recorded).toEqual([there, write]);
    const read = record.take(write.after, shown, 'n', record.mark());
    expect({ child: titled(read, 'ずっと長い題名'), parent: titled(read, '改名') }).toEqual({ child: titled(shown, '子1'), parent: titled(shown, '親') });
  });

  it('matches the change before such a write by titles alone: the untitled twins get new ids, the write\'s edits or not (E05)', () => {
    // Not a regression test (it holds before the fix): it pins that the write's edits are not laid over the change. Titles
    // cannot tell twins apart, so any change the reader did not see renumbers them — with or without a write after it.
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const write = rename(elsewhere(H), '- \n', '- 命名\n');
    record.record(write, H);
    const read = record.take(write.after, shown, 'n', record.mark());
    expect(shown.nodes.map(node => node.id)).not.toContain(first(read));
  });

  it('take: a read that finds the change a write recorded while it was under way was made on keeps the write for the next read', () => {
    // The read is answered with the changed text, and the store writes on it before the reader parses it (the view waits
    // for the maps the note calls; the called maps and the embed yield too).
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const reading = record.mark();
    const write = rename(elsewhere(H), '子1', 'ずっと長い題名');
    record.record(write, H);
    const found = record.take(elsewhere(H), shown, 'n', reading);
    expect(record.size).toBe(1);
    expect(titled(record.take(write.after, found, 'n', record.mark()), 'ずっと長い題名')).toBe(titled(shown, '子1'));
  });

  it('keeps the writes recorded while a read was under way past a change between them, and carries the ids through both', () => {
    // The read finds the text on screen; meanwhile the store writes on it, someone changes the note, and the store writes
    // on the change. Cut at the change, the second write would be left to titles.
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const reading = record.mark();
    const there = rename(H, '子1', 'ずっと長い題名');
    record.record(there, H);
    const write = rename(elsewhere(there.after), '- 親', '- 改名');
    record.record(write, H);
    record.take(H, shown, 'n', reading);
    expect(record.recorded).toEqual([there, write]);
    const read = record.take(write.after, shown, 'n', record.mark());
    expect({ child: titled(read, 'ずっと長い題名'), parent: titled(read, '改名') }).toEqual({ child: titled(shown, '子1'), parent: titled(shown, '親') });
  });

  it('replay and unled (the view): a write on a text not read yet replays after the change; one found by a read is kept', () => {
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const write = rename(elsewhere(H), '子1', 'ずっと長い題名');
    const reading = record.mark();
    record.record(write, H);
    expect(titled(record.replay(write.after, shown, 'n')?.document ?? shown, 'ずっと長い題名')).toBe(titled(shown, '子1'));
    // The view's read that found the change the write was made on (no replay reaches it) passes no write, and spends
    // nothing until it spends what it used (code review 2: a newer read may supersede it first).
    expect(record.replay(elsewhere(H), shown, 'n')).toBeUndefined();
    const unled = record.unled(elsewhere(H), shown, 'n', reading);
    expect({ used: unled.used, recorded: record.recorded }).toEqual({ used: 0, recorded: [write] });
    record.keep(reading, unled.used);
    expect(record.recorded).toEqual([write]);
  });

  it('unled: parses through the writes a read passed and spends none of them; the same parse for the same base', () => {
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const write = rename(H, '子1', 'ずっと長い題名');
    record.record(write, H);
    const added = rename(elsewhere(write.after), '  - 空の子\n', '  - 空の子\n  - 新しい子\n');
    const unled = record.unled(added.after, shown, 'n', record.mark());
    expect({ used: unled.used, size: record.size, renamed: titled(unled.document, 'ずっと長い題名') }).toEqual({ used: 1, size: 1, renamed: titled(shown, '子1') });
    // The write parsed once per base, as a replay (and `carry`, for a draft's base) parses it.
    expect(record.replay(write.after, shown, 'n')?.document).toBe(record.replay(write.after, shown, 'n')?.document);
  });

  it('record: a write on the change the first write was made on cuts the write that was taken back (code review 3)', () => {
    // The reader shows H; someone changes it to X, the store writes w1 on X, the note is put back to X (the Markdown
    // pane's Undo), and the store writes w2 on X. w1 was taken back: replayed, the read would carry 子1 over a rename the
    // note no longer has, and match X by titles from its text, where 子1 is not.
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const w1 = rename(elsewhere(H), '子1', 'ずっと長い題名');
    const w2 = rename(elsewhere(H), '- 親', '- 改名');
    record.record(w1, H);
    record.record(w2, H);
    expect(record.recorded).toEqual([w2]);
    const read = record.take(w2.after, shown, 'n', record.mark());
    expect({ child: titled(read, '子1'), parent: titled(read, '改名') }).toEqual({ child: titled(shown, '子1'), parent: titled(shown, '親') });
  });

  it('record: a write on the text a write in the middle of the record left cuts the record there (code review 2)', () => {
    // [w1 A→B, w2 B→C], the note put back to B (the Markdown pane's Undo), and the map writes w3 on B: w2 was taken
    // back, and replayed it would carry ids over a change the note no longer has.
    const shown = parseMarkdown(H, 'n');
    const record = new WriteRecord();
    const w1 = rename(H, '子1', 'ずっと長い題名');
    const w2 = rename(w1.after, '- 親', '- 改名');
    const w3 = rename(w1.after, '  - 空の子2', '  - 別の子');
    record.record(w1, H);
    record.record(w2, H);
    record.record(w3, H);
    expect(record.recorded).toEqual([w1, w3]);
    const read = record.take(w3.after, shown, 'n', record.mark());
    expect({ parent: titled(read, '親'), renamed: titled(read, 'ずっと長い題名') }).toEqual({ parent: titled(shown, '親'), renamed: titled(shown, '子1') });
  });

  // Until LEV-238 this row pinned that a write on another text was left out. It is now recorded (the rows above), and
  // this pins what stays of the old rule: a write on the text on screen after it starts the record again, so the write
  // on the other text — the note was put back over it — does not stand before it.
  it('starts the record again with a write on the text on screen after a write on a change the reader had not read', () => {
    const shown = parseMarkdown(A, 'n');
    const record = new WriteRecord();
    record.record(rename(A.replace('子1', '外'), '外', 'ずっと長い題名'), A);
    const write = rename(A, '子1', 'ずっと長い題名');
    record.record(write, A);
    expect(record.recorded).toEqual([write]);
    expect(second(record.take(write.after, shown, 'n', record.mark()))).toBe(second(shown));
  });

  it('record: a reader that has parsed nothing keeps only the writes that lead on from the record (code review 1)', () => {
    // Its reads may be failing: kept, every write on the note would wait for a read that does not come. Not a regression
    // test against the code before LEV-238 (it left out every such write); it fails on this branch's first commit, which
    // kept them, and pins that the new rule stops where nothing has been parsed.
    const record = new WriteRecord();
    record.record(rename(H, '子1', 'ずっと長い題名'), undefined);
    expect(record.size).toBe(0);
  });
});
