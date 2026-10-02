/**
 * Branches written in one edit under a node (`add-children`, docs/architecture.md §11.5): what the AI's result is
 * kept as. The text comes from outside the note (a model's answer), so it is made one line, given the depth the
 * node can take, and stripped of the Markdown that would read it as another block — the planner then checks that
 * the note parses back to exactly the branches it wrote. Pure: no Obsidian, no AI module (the shape is the
 * contract's `OutlineItem`, structurally).
 */

export interface NewBranch { text: string; children: NewBranch[] }

/** One written node: its text as written (`inertTitle`) and its depth below the node the branches go under (1 for the top level). */
export interface WrittenBranch { title: string; depth: number }

/**
 * The branches as they can be written under a node that takes `maxDepth` levels: every text on one line (breaks and
 * runs of white space become one space), an empty item dropped with its children moved up to its place, and an item
 * deeper than `maxDepth` moved up to that level, after the item it was under (§11.4: a level the node cannot take is
 * not dropped, it is lifted). `maxDepth` under 1 leaves nothing.
 */
export function fitBranches(branches: readonly NewBranch[], maxDepth: number): NewBranch[] {
  const fit = (items: readonly NewBranch[], depth: number): NewBranch[] => items.flatMap(item => {
    const text = item.text.replace(/\s+/gu, ' ').trim();
    if (!text) return fit(item.children, depth);
    if (depth >= maxDepth) return [{ text, children: [] }, ...fit(item.children, depth)];
    return [{ text, children: fit(item.children, depth + 1) }];
  });
  return maxDepth < 1 ? [] : fit(branches, 1);
}

/** The branches in the order they are written (preorder), with their depth below the node; `form` says how each title is made inert. */
export function writtenBranches(branches: readonly NewBranch[], form: 'heading' | 'item'): WrittenBranch[] {
  const written: WrittenBranch[] = [];
  const walk = (items: readonly NewBranch[], depth: number): void => {
    for (const item of items) {
      written.push({ title: inertTitle(item.text, form), depth });
      walk(item.children, depth + 1);
    }
  };
  walk(branches, 1);
  return written;
}

/** Every count in `branches`, nested ones included. */
export function branchCount(branches: readonly NewBranch[]): number {
  return branches.reduce((count, item) => count + 1 + branchCount(item.children), 0);
}

/**
 * `text` (one line) as the title of a written heading or list item that reads back as that same text and nothing
 * else (§11.4). What a block would start with is escaped by a backslash before it: a heading's `#`, a quote's `>`,
 * a list's marker (`-`/`*`/`+` and a space; `1.`/`1)` and a space, escaped at the delimiter so it still reads
 * `1.`), a task's `[ ]`, a line that is all a thematic break or a Setext underline (`---`, `* * *`, `===`; from two
 * marks, `--` and `**`, since a list item's own marker makes the third: `- --` is a rule), a fence, a math block, HTML
 * (not an autolink `<https://…>`), a link reference definition (`[03:15]: …`). A heading's `#` only as a heading's
 * mark (`#` and a space, or alone): a tag `#重要` is no heading and stays a tag. Two things act wherever they stand and would hide
 * the nodes after the item until they close: Obsidian's comment `%%` (each `%` of a run escaped) and an HTML comment
 * (`<!--` written `&lt;!--`). A heading's closing `#`s are escaped too, so they are not dropped as its closing
 * sequence. Links stay as they are. Idempotent: an escaped title is returned unchanged.
 */
export function inertTitle(text: string, form: 'heading' | 'item'): string {
  let title = text.trim()
    .replace(/%{2,}/gu, run => '\\%'.repeat(run.length))
    .replace(/<!--/gu, '&lt;!--');
  if (/^([-*_])(?:[ \t]*\1)+[ \t]*$/u.test(title) || /^=+[ \t]*$/u.test(title)) title = `\\${title}`;
  else if (/^\d{1,9}[.)](?:[ \t]|$)/u.test(title)) title = title.replace(/^(\d{1,9})/u, '$1\\');
  else if (/^<[a-z][a-z\d+.-]{1,31}:[^\s<>]*>/iu.test(title)) { /* An autolink: a link, which stays (§11.4). */ }
  else if (/^(?:#{1,6}(?:[ \t]|$)|>|[-*+](?:[ \t]|$)|```|~~~|\$\$|<|\[[ xX]\](?:[ \t]|$)|\[[^\]]+\]:)/u.test(title)) title = `\\${title}`;
  if (form === 'heading') title = title.replace(/([ \t])(#+)$/u, (_whole, space: string, marks: string) => space + '\\#'.repeat(marks.length));
  return title;
}
