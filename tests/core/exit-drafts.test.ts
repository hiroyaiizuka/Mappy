import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/core/commands';
import { readExitDrafts, rebaseExitEdits, textFingerprint } from '../../src/core/exit-drafts';

// LEV-230: a draft kept as the page went is applied at the next load to the note as it is then.
describe('rebaseExitEdits', () => {
  const before = '- 親\n  - 子ノード\n- 別のノード\n';
  const rename = [{ from: before.indexOf('子ノード'), to: before.indexOf('子ノード') + 4, text: '新しい名前' }];
  const renamed = applyEdits(before, rename);

  it('keeps the edits on the same note', () => {
    expect(rebaseExitEdits(before, before, rename)).toEqual(rename);
  });

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
    expect(rebaseExitEdits(before, before, two)).toEqual(two);
  });

  it('refuses a draft without its time', () => {
    expect(readExitDrafts([{ path: 'a.md', title: 't', refused: 'x' }])).toEqual([]);
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

  it('tells texts apart by length and hash', () => {
    expect(textFingerprint('abc')).toBe(textFingerprint('abc'));
    expect(textFingerprint('abc')).not.toBe(textFingerprint('abd'));
    expect(textFingerprint('')).toMatch(/^0:/u);
  });
});
