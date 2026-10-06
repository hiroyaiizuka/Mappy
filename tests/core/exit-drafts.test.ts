import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/core/commands';
import { readExitDrafts, rebaseExitEdits, textFingerprint } from '../../src/core/exit-drafts';

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

  // LEV-309: a write cut off as the page went can leave the first part of the note, not 0 bytes. The change is then the
  // lost end, clear of a rename before it, and the rename was written over what was left; the draft, which held the
  // note's text, went with it.
  describe('a note whose end was cut off', () => {
    // A line between the edit and the cut: cut just after the edited line, the change touches the edit, which was
    // refused already. No two lines end alike, so no common end but the line break places the change.
    const long = '- 親\n  - 子ノード\n- 一\n- 二\n- 別の項目\n';
    const last = long.indexOf('- 別の項目');
    it.each([
      ['at the end of a line (its line break a common end)', long.slice(0, long.indexOf('- 二'))],
      ['inside the last line', long.slice(0, last + 3)],
      ['by its last line break alone', long.slice(0, -1)],
    ])('refuses it cut %s', (_shape, current) => {
      expect(rebaseExitEdits(long, current, rename)).toBeNull();
    });
  });

  it('refuses a note cut off in the middle of a write that made it longer', () => {
    // Another write was putting a line in after the edit when the page went: more is left than the draft's note had,
    // but its end is gone.
    const written = before.replace('- 別のノード\n', '- 足した\n- 別のノード\n');
    const current = written.slice(0, -2);
    expect(current.length).toBeGreaterThan(before.length);
    expect(rebaseExitEdits(before, current, rename)).toBeNull();
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

  it('refuses a note without a final line break cut inside its last line', () => {
    const bare = before.slice(0, -1);
    expect(rebaseExitEdits(bare, bare.slice(0, -2), rename)).toBeNull();
    // The cost: a change there that runs to the very end looks the same, and is refused too (told and kept, as E05).
    expect(rebaseExitEdits(bare, bare.replace('別のノード', '別の名前'), rename)).toBeNull();
  });

  // Passes without LEV-309 too: text only added at the very end leaves all of the note there, and still moves.
  it('still moves over text added at the very end of a note without a final line break', () => {
    const bare = before.slice(0, -1);
    const added = `${bare}\n- 足した`;
    expect(applyEdits(added, rebaseExitEdits(bare, added, rename)!)).toBe(added.replace('子ノード', '新しい名前'));
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
