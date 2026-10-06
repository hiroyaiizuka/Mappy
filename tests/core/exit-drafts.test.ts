import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/core/commands';
import { readExitDrafts, rebaseExitEdits, rebaseOverDraft, textFingerprint } from '../../src/core/exit-drafts';

// LEV-230: a draft kept as the page went is applied at the next load to the note as it is then.
describe('rebaseExitEdits', () => {
  const before = '- 親\n  - 子ノード\n- 別のノード\n';
  const rename = [{ from: before.indexOf('子ノード'), to: before.indexOf('子ノード') + 4, text: '新しい名前' }];
  const renamed = applyEdits(before, rename);

  it('moves the edits over a change after them', () => {
    const current = before.replace('- 別のノード\n', '- 別のノード\n- 足した\n');
    expect(applyEdits(current, rebaseExitEdits(before, current, rename)!)).toBe(current.replace('子ノード', '新しい名前'));
  });

  it('moves the edits over a change before them, by its change in length', () => {
    const current = '- 前に足した\n' + before;
    expect(applyEdits(current, rebaseExitEdits(before, current, rename)!)).toBe('- 前に足した\n' + renamed);
    const shorter = before.replace('- 親\n', '- P\n');
    expect(applyEdits(shorter, rebaseExitEdits(before, shorter, rename)!)).toBe(renamed.replace('- 親\n', '- P\n'));
  });

  it('refuses a change inside the edited range or touching it', () => {
    expect(rebaseExitEdits(before, before.replace('子ノード', '子ノード2'), rename)).toBeNull();
    expect(rebaseExitEdits(before, before.replace('子ノード', 'X子ノード'), rename)).toBeNull();
    expect(rebaseExitEdits(before, before.replace('子ノード', '別'), rename)).toBeNull();
  });

  it('refuses an emptied note', () => {
    expect(rebaseExitEdits(before, '', rename)).toBeNull();
  });

  // Review 2: a plan of more edits (a topic's frontmatter keys and position) depends on the rest of the note, and is
  // not planned again here: it applies only to the note it was planned on.
  it('moves only a plan of one edit', () => {
    const two = [...rename, { from: 0, to: 0, text: '---\nmappy: true\n---\n' }];
    const current = before.replace('- 別のノード\n', '- 別のノード\n- 足した\n');
    expect(rebaseExitEdits(before, current, two)).toBeNull();
  });

  // Review 3: in repeated text the change's place is ambiguous, and the one diff picked could hand the draft to
  // another node of the same title (AGENTS.md: 同名見出し).
  it('refuses a change whose place in repeated text could reach the edit', () => {
    const twins = '- A\n- A\n';
    const first = [{ from: 2, to: 3, text: 'B' }];
    // Either line may be the one gone: the draft of the first A must not land on what is left.
    expect(rebaseExitEdits(twins, '- A\n', first)).toBeNull();
    // A same-titled node added above: the draft stays with its own A, not the new one.
    const nested = '- A\n  - x\n';
    expect(rebaseExitEdits(nested, '- A\n  - y\n- A\n  - x\n', [{ from: 2, to: 3, text: 'B' }])).toBeNull();
    // Unambiguous text around it still moves.
    const current = '- 前\n' + twins;
    expect(applyEdits(current, rebaseExitEdits(twins, current, [{ from: 6, to: 7, text: 'B' }])!)).toBe('- 前\n- A\n- B\n');
  });

  // LEV-309: a write cut off as the page went can leave the first part of what it was writing, not 0 bytes. The change
  // is then the lost end, clear of a rename before it, and the rename was written over what was left; the draft, which
  // held the note's text, went with it. In each fixture a line stands between the edit and the cut (cut just after the
  // edited line, the change touches the edit, which was refused already).
  describe('a note cut off', () => {
    // No two lines end alike, so nothing but a line break is a common end.
    const long = '- 親\n  - 子ノード\n- 一\n- 二\n- 別の項目\n';
    const last = long.indexOf('- 別の項目');
    // The last line's title again higher up, at the same depth and at another.
    const same = '- 親\n  - 子ノード\n- 一\n- メモ\n- 別\n- メモ\n';
    const deeper = '- 親\n  - 子ノード\n- 別\n  - メモ\n- メモ\n';

    it.each([
      ['at the end of a line', long.slice(0, long.indexOf('- 二'))],
      ['inside its last line', long.slice(0, last + 3)],
    ])('refuses the first part of the note itself, cut %s', (_shape, current) => {
      expect(rebaseExitEdits(long, current, rename)).toBeNull();
    });

    // Review 1 of LEV-309: what is left can end with a whole line the same as the last one; the change placed as early
    // as it goes then stops short of the last line.
    it('refuses the first part of the note itself ending with a line the same as the last one', () => {
      expect(rebaseExitEdits(same, same.slice(0, same.indexOf('- 別')), rename)).toBeNull();
    });

    // Another write was changing the note after the edit when the page went: what is left is not the first part of the
    // note the draft was planned on, but its end is gone all the same.
    const putIn = long.replace('- 二\n', '- 足した\n- 二\n');
    const renamedLine = long.replace('- 一\n', '- 一つ\n');
    const renamedDeeper = deeper.replace('- 別\n', '- 別2\n');
    it.each([
      ['with a line put in (more is left than the note had)', long, putIn.slice(0, -2)],
      ['with a line renamed, at the end of a line', long, renamedLine.slice(0, renamedLine.indexOf('- 別の項目'))],
      // Review 1 of LEV-309: the text left ends like the last line (a same-titled node at another depth), not with it.
      ['with a line renamed, just after a same-titled node at another depth', deeper, renamedDeeper.slice(0, renamedDeeper.lastIndexOf('- メモ'))],
    ])('refuses what is left of a write %s', (_shape, source, current) => {
      expect(source.startsWith(current)).toBe(false);
      expect(rebaseExitEdits(source, current, rename)).toBeNull();
    });

    it('refuses a note without a final line break cut inside its last line by a write that changed it', () => {
      const bare = long.slice(0, -1);
      expect(rebaseExitEdits(bare, bare.replace('別の項目', '別の名'), rename)).toBeNull();
    });
  });

  // Passes without LEV-309 too: what it holds is that the guard leaves LEV-230's moves alone, a change of the last line
  // within it, and a line taken out above it (as late as it goes, that change reaches into the last line; as early as
  // it goes, it does not: the guard places it early).
  it('still moves over a change of the last line that keeps its line break, and over a line taken out above it', () => {
    const last = before.replace('- 別のノード\n', '- 別の名前\n');
    expect(applyEdits(last, rebaseExitEdits(before, last, rename)!)).toBe(last.replace('子ノード', '新しい名前'));
    const longer = before.replace('- 別のノード\n', '- 一\n- 真ん中\n- 別のノード\n');
    const current = longer.replace('- 真ん中\n', '');
    expect(applyEdits(current, rebaseExitEdits(longer, current, rename)!)).toBe(current.replace('子ノード', '新しい名前'));
  });

  // Review 1 of LEV-309: a change that takes only blank text at the end (a trailing blank line, the last line break)
  // loses nothing, and was refused as a cut.
  it('still moves over a change that takes only blank text at the end', () => {
    expect(applyEdits(before.slice(0, -1), rebaseExitEdits(before, before.slice(0, -1), rename)!)).toBe(renamed.slice(0, -1));
    expect(applyEdits(before, rebaseExitEdits(`${before}\n`, before, rename)!)).toBe(renamed);
  });

  // Passes without LEV-309 too: text only added at the very end leaves all of the note there, and still moves.
  it('still moves over text added at the very end of a note without a final line break', () => {
    const bare = before.slice(0, -1);
    const added = `${bare}\n- 足した`;
    expect(applyEdits(added, rebaseExitEdits(bare, added, rename)!)).toBe(added.replace('子ノード', '新しい名前'));
  });

  // What the guard cannot tell from a cut, refused the same way (told and kept, as E05): the person's change of the last
  // line of a note without a final line break, to its very end; and taking the last node out.
  it('refuses a change of the person of the same shape as a cut', () => {
    const bare = before.slice(0, -1);
    expect(rebaseExitEdits(bare, bare.replace('別のノード', '別の名前'), rename)).toBeNull();
    const three = `${before}- 三\n`;
    expect(rebaseExitEdits(three, before, rename)).toBeNull();
  });
});

// LEV-309, review 1: two maps of a note, each with a draft. The first written leaves a note whose change the second
// knows exactly (the first's edits), where a diff would guess, and saw the last line renamed to the very end as a cut.
describe('rebaseOverDraft', () => {
  const bare = '- 親\n  - 子ノード\n- 別のノード';
  const rename = [{ from: bare.indexOf('子ノード'), to: bare.indexOf('子ノード') + 4, text: '新しい名前' }];
  const lastLine = [{ from: bare.indexOf('別のノード'), to: bare.length, text: '別の名前' }];

  it('moves a rename over the edits of another draft of the note', () => {
    const first = applyEdits(bare, lastLine);
    expect(rebaseExitEdits(bare, first, rename)).toBeNull();
    expect(applyEdits(first, rebaseOverDraft(rename, lastLine)!)).toBe('- 親\n  - 新しい名前\n- 別の名前');
    const other = applyEdits(bare, rename);
    expect(applyEdits(other, rebaseOverDraft(lastLine, rename)!)).toBe('- 親\n  - 新しい名前\n- 別の名前');
  });

  it('refuses a plan of more edits, and one over edits that reach it', () => {
    expect(rebaseOverDraft([...lastLine, { from: 0, to: 0, text: '---\nmappy: true\n---\n' }], rename)).toBeNull();
    expect(rebaseOverDraft(rename, [{ from: rename[0]!.from, to: rename[0]!.to, text: '外' }])).toBeNull();
  });
});

describe('readExitDrafts', () => {
  it('keeps the planned note text when it is there, and drops a malformed one', () => {
    const edits = [{ from: 0, to: 1, text: 'x' }];
    const kept = { path: 'a.md', title: 't', at: 1, before: textFingerprint('ab'), after: textFingerprint('xb'), edits, source: 'ab' };
    const withoutSource = { path: kept.path, title: kept.title, at: kept.at, before: kept.before, after: kept.after, edits };
    expect(readExitDrafts([kept, { ...kept, source: 3 }])).toEqual([kept, withoutSource]);
    expect(readExitDrafts([{ ...kept, edits: [] }, { ...kept, edits: [{ from: 2, to: 1, text: '' }] }, null, 'x'])).toEqual([]);
  });

  it('refuses a draft without its time', () => {
    expect(readExitDrafts([{ path: 'a.md', title: 't', refused: 'x' }])).toEqual([]);
  });

  it('tells texts apart by length and hash', () => {
    expect(textFingerprint('abc')).toBe(textFingerprint('abc'));
    expect(textFingerprint('abc')).not.toBe(textFingerprint('abd'));
    expect(textFingerprint('')).toMatch(/^0:/u);
  });
});
