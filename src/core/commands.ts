import { parseMarkdown, projectMap, type MindDocument, type MindNode } from './markdown';
import { planListEdit } from './list-commands';
import { planTopicRekey, readTopicPositions, topicKeys, type TopicPlacement } from './topics';

export interface TextEdit { from: number; to: number; text: string }

/** Place the node as child number `index` of `parentId`, counted without the node itself. */
export interface MoveCommand { type: 'move'; nodeId: string; parentId: string; index: number }

export type EditCommand =
  /** `position` stores one layout position under the new title in the same edit set (a topic added on the map). */
  | { type: 'rename'; nodeId: string; title: string; position?: TopicPlacement }
  /**
   * A new last child. Empty by default (the inline editor names it); `title` writes the item's
   * text in the same edit, so `![[map]]` called from the search (§5 M12) is one step, as Tab is.
   */
  | { type: 'add-child'; nodeId: string; title?: string }
  | { type: 'add-sibling' | 'delete' | 'move-up' | 'move-down'; nodeId: string }
  | { type: 'reparent'; nodeId: string; parentId: string }
  /**
   * Append a top-level section at the end of the document: a new free topic (§5 M7). Empty by default
   * (the inline editor names it); `title` writes the heading's text in the same edit, so a map called
   * with nothing selected (`## ![[map]]`, §5 M12) is one step, as the empty topic is.
   */
  | { type: 'add-topic'; title?: string }
  /** Detach a branch into a new top-level section at the end: a free topic placed at `position` (§5 M7 切り離し). */
  | { type: 'detach'; nodeId: string; position?: TopicPlacement }
  | MoveCommand;

export type DropPosition = 'before' | 'after' | 'inside';

export interface EditPlan { edits: TextEdit[]; selectionOffset: number | null }

export function applyEdits(source: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let previous: TextEdit | undefined;
  for (const edit of ordered) {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to)
      || edit.from < 0 || edit.to < edit.from || edit.to > source.length
      || typeof edit.text !== 'string') throw new Error('編集範囲が不正です。');
    if (previous && (edit.from < previous.to || edit.from === previous.from)) {
      throw new Error('編集範囲が重複しています。');
    }
    previous = edit;
  }
  let result = source;
  for (const edit of ordered.reverse()) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  return result;
}

/** The node an edit or a kept draft addresses; a re-parse after an external change may have dropped the id. */
export function getNode(doc: MindDocument, id: string): MindNode {
  const node = id === 'root' ? doc.root : doc.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error('対象のノードが変更されています。再選択してください。');
  return node;
}

function checkedPlan(doc: MindDocument, edits: TextEdit[], selectionOffset: number | null, count: number): EditPlan {
  const source = applyEdits(doc.source, edits);
  if (parseMarkdown(source, doc.root.title, undefined, doc.format).nodes.length !== count) {
    throw new Error('見出し構造を安全に変更できません。Markdown の構文を確認してください。');
  }
  return { edits, selectionOffset };
}

interface MoveTarget { parent: MindNode; siblings: MindNode[]; unchanged: boolean }

/** Resolve the destination shared by both formats; `siblings` exclude the moving node. */
export function moveTarget(doc: MindDocument, node: MindNode, parentId: string, index: number): MoveTarget {
  const parent = getNode(doc, parentId);
  if (parent.id === node.id || (parent.kind !== 'root' && parent.from >= node.from && parent.from < node.to)) {
    throw new Error('ノードを自分自身や子孫の下へ移動できません。');
  }
  const siblings = parent.children.filter((child) => child.id !== node.id);
  if (!Number.isInteger(index) || index < 0 || index > siblings.length) throw new Error('移動先の位置が不正です。');
  const current = parent.children.findIndex((child) => child.id === node.id);
  return { parent, siblings, unchanged: current === index };
}

/** Preorder depth and title of every node; the optional move is simulated on the current tree. */
function treeShape(root: MindNode, moved?: { node: MindNode; parent: MindNode; index: number }): string[] {
  const shape: string[] = [];
  const pending = [{ node: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    shape.push(`${current.depth}:${current.node.title}`);
    let children = moved ? current.node.children.filter((child) => child.id !== moved.node.id) : current.node.children;
    if (moved && current.node.id === moved.parent.id) {
      children = [...children.slice(0, moved.index), moved.node, ...children.slice(moved.index)];
    }
    for (let position = children.length - 1; position >= 0; position--) {
      const child = children[position];
      if (child) pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return shape;
}

/** Accept a move only when the reparsed tree is exactly the current tree with the node relocated. */
export function checkedMove(
  doc: MindDocument, edits: TextEdit[], node: MindNode, parent: MindNode, index: number, insertedFrom: number,
): EditPlan {
  const parsed = parseMarkdown(applyEdits(doc.source, edits), doc.root.title, undefined, doc.format);
  const expected = treeShape(doc.root, { node, parent, index });
  const actual = treeShape(parsed.root);
  const moved = parsed.nodes.find((candidate) => candidate.from === insertedFrom);
  if (!moved || moved.title !== node.title || expected.length !== actual.length
    || expected.some((entry, position) => entry !== actual[position])) {
    throw new Error(doc.format === 'list'
      ? 'リスト構造を安全に変更できません。Markdown の構文を確認してください。'
      : '見出し構造を安全に変更できません。Markdown の構文を確認してください。');
  }
  return { edits, selectionOffset: moved.titleFrom };
}

function branchNodes(doc: MindDocument, node: MindNode): MindNode[] {
  return doc.nodes.filter((candidate) => candidate.from >= node.from && candidate.from < node.to);
}

function shiftedBranch(doc: MindDocument, node: MindNode, level: number): string {
  const delta = level - node.level;
  const edits: TextEdit[] = [];
  for (const descendant of branchNodes(doc, node)) {
    const nextLevel = descendant.level + delta;
    if (nextLevel < 1 || nextLevel > 6) throw new Error('見出しは子孫を含めて 6 階層までです。');
    if (delta === 0) continue;
    if (descendant.kind === 'setext') {
      if (/[\r\n]/u.test(descendant.title)) throw new Error('複数行の Setext 見出しは Markdown 側で移動してください。');
      edits.push({ from: descendant.from - node.from, to: descendant.headingTo - node.from,
        text: `${'#'.repeat(nextLevel)} ${descendant.title}` });
    } else {
      const marker = /^ {0,3}#{1,6}/u.exec(doc.source.slice(descendant.from, descendant.headingTo));
      if (!marker) throw new Error('見出しの編集位置を確認できません。');
      const indent = marker[0].indexOf('#');
      edits.push({ from: descendant.from - node.from + indent,
        to: descendant.from - node.from + marker[0].length, text: '#'.repeat(nextLevel) });
    }
  }
  return applyEdits(doc.source.slice(node.from, node.to), edits);
}

export function insertionPrefix(source: string, offset: number, eol: string): string {
  const before = source.slice(0, offset);
  if (!before || /\n[ \t]*\r?\n$/u.test(before)) return '';
  return before.endsWith('\n') ? eol : eol + eol;
}

function appendBoundary(text: string, eol: string): string {
  if (/\n[ \t]*\r?\n$/u.test(text)) return text;
  return text + (text.endsWith('\n') ? eol : eol + eol);
}

/** The line breaks and whitespace-only lines that end `text` (a last one without a break included), or '' when its last line has neither. */
function endingBreaks(text: string): string {
  return /(?:\r?\n[ \t]*)+$/u.exec(text)?.[0] ?? '';
}

function withoutEndingBreaks(text: string): string {
  return text.slice(0, text.length - endingBreaks(text).length);
}

/** `breaks` with a blank line: itself when it already ends with one, otherwise one more line break. */
function withBlankLine(breaks: string, eol: string): string {
  return /\n[ \t]*\r?\n$/u.test(breaks) ? breaks : breaks + eol;
}

/**
 * Swap `node` with `neighbor`, its sibling section `direction` away; `moved` is the node's text as it lands (its
 * depth adjusted). Sibling sections are adjacent and a section's range ends with the blank lines before the next
 * heading (or the file's ending), so only the sections' own lines change places: the earlier one's ending stays as
 * the seam and the later one's ending stays at the end, and the swap back restores the source (AGENTS.md: 無関係な
 * 内容を再シリアライズしない). The whole tree is compared; when the lines brought together would join into another
 * block (a paragraph before a Setext underline, an HTML block before the next heading), the seam and, unless the pair
 * ends the file, the ending get a blank line instead.
 */
export function swapSections(doc: MindDocument, node: MindNode, neighbor: MindNode, direction: number, moved: string): EditPlan {
  const parent = getNode(doc, node.parentId ?? 'root');
  const index = parent.children.findIndex((child) => child.id === node.id) + direction;
  const other = doc.source.slice(neighbor.from, neighbor.to);
  const from = Math.min(node.from, neighbor.from);
  const to = Math.max(node.to, neighbor.to);
  const [earlier, later] = direction < 0 ? [other, moved] : [moved, other];
  const first = withoutEndingBreaks(later);
  const second = withoutEndingBreaks(earlier);
  const seam = endingBreaks(earlier);
  const ending = endingBreaks(later);
  const attempt = (seam: string, ending: string): EditPlan => checkedMove(doc, [{ from, to, text: first + seam + second + ending }],
    node, parent, index, direction < 0 ? from : from + first.length + seam.length);
  try {
    return attempt(seam, ending);
  } catch (error) {
    const wideSeam = withBlankLine(seam, doc.eol);
    const wideEnding = to === doc.source.length ? ending : withBlankLine(ending, doc.eol);
    if (wideSeam === seam && wideEnding === ending) throw error;
    return attempt(wideSeam, wideEnding);
  }
}

/** A node's text is one line: a break would start another block and change the tree. */
export function assertSingleLine(title: string): void {
  if (/[\r\n\u2028\u2029]/u.test(title)) {
    throw new Error('ノード名は改行を含まない文字列にしてください。');
  }
}

function rename(doc: MindDocument, node: MindNode, title: string, place?: TopicPlacement): EditPlan {
  assertSingleLine(title);
  if (node.kind === 'setext' && title.trim().length === 0) {
    throw new Error('Setext 見出しは空にできません。Markdown 側で ATX 見出しへ変更してください。');
  }
  const before = (node.kind === 'atx' || node.kind === 'list') && !/[ \t]/u.test(doc.source.charAt(node.titleFrom - 1)) ? ' ' : '';
  const after = node.kind === 'atx' && node.titleFrom === node.titleTo && doc.source.charAt(node.titleTo) === '#' ? ' ' : '';
  const edit = { from: node.titleFrom, to: node.titleTo, text: before + title + after };
  const parsed = parseMarkdown(applyEdits(doc.source, [edit]), doc.root.title, undefined, doc.format);
  const updated = parsed.nodes.find((candidate) => candidate.from === node.from);
  if (parsed.nodes.length !== doc.nodes.length || updated?.kind !== node.kind
    || updated.level !== node.level || updated.title !== title.trim()) {
    throw new Error('この名前は見出し構文を変えてしまいます。Markdown 側で編集してください。');
  }
  // A free topic's stored position follows its key within the same edit set (another topic of the old heading
  // may become its first, and take the plain key). Only topics carry entries: a list item or the body root
  // that happens to share a topic's text does not.
  const plan = { edits: [edit], selectionOffset: updated.titleFrom };
  return projectMap(doc).topics.some((topic) => topic.id === node.id) ? withTopicKeys(doc, plan, node, 'lands', place) : plan;
}

function add(doc: MindDocument, node: MindNode, sibling: boolean, title = ''): EditPlan {
  assertSingleLine(title);
  const level = sibling ? node.level : node.level + 1;
  if (level > 6) throw new Error('見出しは 6 階層までです。');
  const offset = node.to;
  const prefix = insertionPrefix(doc.source, offset, doc.eol);
  const suffix = offset < doc.source.length ? doc.eol + doc.eol : doc.source.endsWith('\n') ? doc.eol : '';
  const text = `${prefix}${'#'.repeat(level)} ${title}${suffix}`;
  const edits = [{ from: offset, to: offset, text }];
  const parsed = parseMarkdown(applyEdits(doc.source, edits), doc.root.title, undefined, doc.format);
  const added = parsed.nodes.find((candidate) => candidate.from === offset + prefix.length);
  if (parsed.nodes.length !== doc.nodes.length + 1 || added?.kind !== 'atx'
    || added.level !== level || added.title !== title.trim()) {
    throw new Error('見出し構造を安全に変更できません。Markdown の構文を確認してください。');
  }
  return { edits, selectionOffset: added.titleFrom };
}

/** Swap the node with its neighbour; the moved section adopts the neighbour's depth, so skipped depths stay siblings. */
function move(doc: MindDocument, node: MindNode, direction: number): EditPlan {
  const parent = getNode(doc, node.parentId ?? 'root');
  const neighbor = parent.children[parent.children.findIndex((child) => child.id === node.id) + direction];
  if (!neighbor) return { edits: [], selectionOffset: node.titleFrom };
  return swapSections(doc, node, neighbor, direction, shiftedBranch(doc, node, neighbor.level));
}

/** Text placed at the very end keeps the document's own EOF convention: one newline or none. */
function matchEndOfFile(doc: MindDocument, text: string, target: number): string {
  if (target !== doc.source.length) return text;
  const trimmed = text.replace(/(?:\r?\n)+$/u, '');
  return doc.source.endsWith('\n') ? trimmed + doc.eol : trimmed;
}

/**
 * Move a heading section (with body and descendants) to a position among a parent's children.
 * The moved heading adopts the depth of the sibling it lands next to, so skipped depths stay siblings.
 * Also used for H2 sections of list documents, whose depth never changes.
 */
export function moveHeadingSection(doc: MindDocument, node: MindNode, parentId: string, index: number): EditPlan {
  const { parent, siblings, unchanged } = moveTarget(doc, node, parentId, index);
  if (unchanged) return { edits: [], selectionOffset: node.titleFrom };
  const before = siblings[index];
  const level = before?.level ?? siblings[siblings.length - 1]?.level ?? parent.level + 1;
  const moved = shiftedBranch(doc, node, level);
  const target = before?.from ?? parent.to;
  const removalFrom = target < node.from ? sectionRemovalFrom(doc, node) : node.from;
  const remaining = doc.source.slice(0, removalFrom) + doc.source.slice(node.to);
  const offset = target >= node.to ? target - (node.to - removalFrom) : target;
  const prefix = insertionPrefix(remaining, offset, doc.eol);
  const body = offset < remaining.length ? appendBoundary(moved, doc.eol) : moved;
  const text = matchEndOfFile(doc, prefix + body, target);
  const edits: TextEdit[] = offset === removalFrom
    ? [{ from: removalFrom, to: node.to, text }]
    : [{ from: removalFrom, to: node.to, text: '' }, { from: target, to: target, text }];
  return checkedMove(doc, edits, node, parent, index, offset + prefix.length);
}

/**
 * Where removing a section starts: a section that ends the file also takes the blank lines that
 * separated it from the previous one, so the file keeps its ending instead of a dangling blank line.
 */
export function sectionRemovalFrom(doc: MindDocument, node: MindNode): number {
  if (node.to !== doc.source.length) return node.from;
  const trailing = doc.source.slice(0, node.from).match(/(?:\r?\n)+$/u)?.[0].length ?? 0;
  return node.from - trailing + (doc.source.endsWith('\n') && trailing > 0 ? doc.eol.length : 0);
}

function branchDepth(doc: MindDocument, node: MindNode): number {
  return branchNodes(doc, node).reduce((depth, descendant) => Math.max(depth, descendant.level - node.level), 0);
}

/** Translate a pointer drop on `targetId` into a move, or null when the drop must be refused. */
export function resolveDrop(doc: MindDocument, draggedId: string, targetId: string, position: DropPosition): MoveCommand | null {
  const lookup = (id: string | null): MindNode | undefined =>
    id === 'root' ? doc.root : doc.nodes.find((candidate) => candidate.id === id);
  const node = doc.nodes.find((candidate) => candidate.id === draggedId);
  const target = lookup(targetId);
  if (!node || !target || node.id === target.id) return null;
  const parent = position === 'inside' ? target : lookup(target.parentId ?? 'root');
  if (!parent || parent.id === node.id || (parent.kind !== 'root' && parent.from >= node.from && parent.from < node.to)) return null;
  // A top-level section goes under a node only when it is a free topic (§5 M7): the body root never does, in either format.
  if (node.parentId === 'root' && node.kind !== 'list' && parent.kind !== 'root' && !projectMap(doc).topics.some((topic) => topic.id === node.id)) return null;
  // List items stay under sections.
  if (doc.format === 'list' && node.kind === 'list' && parent.kind === 'root') return null;
  const siblings = parent.children.filter((child) => child.id !== node.id);
  const index = position === 'inside'
    ? siblings.length
    : siblings.findIndex((child) => child.id === target.id) + (position === 'after' ? 1 : 0);
  if (doc.format === 'headings') {
    const level = siblings[index]?.level ?? siblings[siblings.length - 1]?.level ?? parent.level + 1;
    if (level + branchDepth(doc, node) > 6) return null;
  }
  return { type: 'move', nodeId: node.id, parentId: parent.id, index };
}

/**
 * A top-level section at the very end of the document, at the depth of the last one (`## ` for list
 * documents), empty or titled. It shows as a free topic unless the document had no heading yet.
 */
function addTopic(doc: MindDocument, title = ''): EditPlan {
  assertSingleLine(title);
  const sections = doc.root.children.filter((child) => child.kind !== 'list');
  const level = sections[sections.length - 1]?.level ?? (doc.format === 'list' ? 2 : 1);
  const offset = doc.source.length;
  const prefix = insertionPrefix(doc.source, offset, doc.eol);
  const suffix = doc.source.endsWith('\n') ? doc.eol : '';
  const edits = [{ from: offset, to: offset, text: `${prefix}${'#'.repeat(level)} ${title}${suffix}` }];
  const parsed = parseMarkdown(applyEdits(doc.source, edits), doc.root.title, undefined, doc.format);
  const added = parsed.nodes.find((candidate) => candidate.from === offset + prefix.length);
  if (parsed.nodes.length !== doc.nodes.length + 1 || added?.kind !== 'atx' || added.level !== level
    || added.title !== title.trim() || added.parentId !== 'root') {
    throw new Error('文書末尾にトピックを追加できません。Markdown の構文を確認してください。');
  }
  return { edits, selectionOffset: added.titleFrom };
}

/** How a structural plan moves `node` with respect to the top level, for `withTopicKeys`. */
type TopicRole =
  /** The node is removed (a deletion). */
  | 'leaves'
  /** The node is at the plan's selection afterwards (a move, a detach, a rename). */
  | 'lands'
  /** The plan's selection is a node the plan adds; `node` itself stays. */
  | 'adds';

/**
 * Keep every free topic's `mappy-topics` entry with its topic through `plan` (§7). The topics of the note
 * after the plan correspond in order to the topics of `doc`, `node` set aside as `role` says, and an entry
 * whose key (`topicKeys`) changes moves to the new key in the same edit set: the second topic of a heading
 * takes the plain key when the first leaves, a renamed topic keeps its position under its new key, a
 * reordered pair swaps. The entry of a topic that leaves the top level (deleted, joined) goes with it, so
 * Undo restores both, and `place` stores the pressed point under the node's key afterwards (a topic named
 * or detached on the map). A plan that changes hands between the body and its topics is left alone rather
 * than guessed; so is one that moves no entry.
 */
function withTopicKeys(doc: MindDocument, plan: EditPlan, node: MindNode | undefined, role: TopicRole, place?: TopicPlacement): EditPlan {
  if (plan.edits.length === 0 || (!place && readTopicPositions(doc.source).size === 0)) return plan;
  const after = parseMarkdown(applyEdits(doc.source, plan.edits), doc.root.title, undefined, doc.format);
  const settled = plan.selectionOffset === null ? undefined : after.nodes.find((candidate) => candidate.titleFrom === plan.selectionOffset);
  if (role !== 'leaves' && !settled) return plan;
  const before = projectMap(doc).topics.filter((topic) => role === 'adds' || topic.id !== node?.id);
  const next = projectMap(after).topics.filter((topic) => role === 'leaves' || topic.id !== settled?.id);
  if (before.length !== next.length) return plan;
  const keysBefore = topicKeys(doc);
  const keysAfter = topicKeys(after);
  const rekeys = new Map<string, string>();
  before.forEach((topic, index) => {
    const from = keysBefore.get(topic.id);
    const to = keysAfter.get(next[index]?.id ?? '');
    if (from !== undefined && to !== undefined) rekeys.set(from, to);
  });
  // The node's own entry: carried to where it lands, dropped when it leaves the top level (joined or deleted).
  const own = role === 'adds' || !node ? undefined : keysBefore.get(node.id);
  const landed = role === 'leaves' || !settled ? undefined : keysAfter.get(settled.id);
  const dropped = new Set<string>();
  if (own !== undefined && landed !== undefined) rekeys.set(own, landed);
  else if (own !== undefined) dropped.add(own);
  const key = planTopicRekey(doc, rekeys, dropped, place && landed !== undefined ? { ...place, key: landed } : undefined);
  if (!key) return plan;
  const delta = key.text.length - (key.to - key.from);
  // A header created at offset 0 lands where a branch removal at the top of the note starts: one edit, not two overlapping ones.
  const edits = plan.edits.some((edit) => edit.from === key.from && key.from === key.to)
    ? plan.edits.map((edit) => edit.from === key.from ? { ...edit, text: key.text + edit.text } : edit)
    : [key, ...plan.edits];
  const combined = parseMarkdown(applyEdits(doc.source, edits), doc.root.title, undefined, doc.format);
  if (combined.nodes.length !== after.nodes.length || combined.nodes.some((candidate, index) => candidate.title !== after.nodes[index]?.title)) {
    throw new Error('frontmatter の mappy-topics を更新できません。Markdown 側で確認してください。');
  }
  const selectionOffset = plan.selectionOffset !== null && plan.selectionOffset >= key.to ? plan.selectionOffset + delta : plan.selectionOffset;
  return { edits, selectionOffset };
}

/**
 * Whether a structural command can change which sections are topics, or their order: only then can keys
 * move. A list item never does (items before the first H2 sit on the virtual root, but are not sections).
 */
function touchesTopLevel(doc: MindDocument, node: MindNode, command: Exclude<EditCommand, { type: 'rename' | 'add-topic' }>): boolean {
  const section = node.kind !== 'list' && node.parentId === 'root';
  switch (command.type) {
    case 'add-child': return node.kind === 'root';
    case 'add-sibling': case 'delete': case 'move-up': case 'move-down': return section;
    case 'move': case 'reparent': return section || (node.kind !== 'list' && getNode(doc, command.parentId).kind === 'root');
    case 'detach': return true;
  }
}

function planHeadingEdit(doc: MindDocument, node: MindNode, command: Exclude<EditCommand, { type: 'rename' | 'add-topic' }>): EditPlan {
  switch (command.type) {
    case 'add-child': return add(doc, node, false, command.title);
    case 'add-sibling': return add(doc, node, true);
    case 'delete': return checkedPlan(doc, [{ from: sectionRemovalFrom(doc, node), to: node.to, text: '' }],
      getNode(doc, node.parentId ?? 'root').titleFrom, doc.nodes.length - branchNodes(doc, node).length);
    case 'move-up': return move(doc, node, -1);
    case 'move-down': return move(doc, node, 1);
    case 'reparent': return moveHeadingSection(doc, node, command.parentId,
      getNode(doc, command.parentId).children.filter((child) => child.id !== node.id).length);
    case 'move': return moveHeadingSection(doc, node, command.parentId, command.index);
    // A heading branch detaches by moving to the end of the top level; its depth follows the last section there.
    case 'detach': return moveHeadingSection(doc, node, 'root', doc.root.children.filter((child) => child.id !== node.id).length);
  }
}

export function planEdit(doc: MindDocument, command: EditCommand): EditPlan {
  // A new section whose text is an ordinal key (`A (2)`) renumbers the topics of that heading: their entries follow.
  if (command.type === 'add-topic') return withTopicKeys(doc, addTopic(doc, command.title), undefined, 'adds');
  const node = getNode(doc, command.nodeId);
  if (node.kind === 'root' && command.type !== 'add-child') throw new Error('ルートでは子ノードの追加だけを行えます。');
  if (command.type === 'rename') return rename(doc, node, command.title, command.position);
  const plan = doc.format === 'list' ? planListEdit(doc, node, command) : planHeadingEdit(doc, node, command);
  if (!touchesTopLevel(doc, node, command)) return plan;
  if (command.type === 'detach') return withTopicKeys(doc, plan, node, 'lands', command.position);
  if (command.type === 'delete') return withTopicKeys(doc, plan, node, 'leaves');
  return withTopicKeys(doc, plan, node, command.type === 'add-child' || command.type === 'add-sibling' ? 'adds' : 'lands');
}
