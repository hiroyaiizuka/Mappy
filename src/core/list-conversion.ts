import { applyEdits, type TextEdit } from './commands';
import { parseMarkdown, type MindDocument, type MindNode } from './markdown';

function indentBody(source: string, node: MindNode, depth: number, edits: TextEdit[]): void {
  const indent = '  '.repeat(depth + 1);
  let from = node.bodyFrom;
  while (from < node.bodyTo) {
    const newline = source.indexOf('\n', from);
    const to = newline < 0 ? node.bodyTo : Math.min(newline, node.bodyTo);
    // Leave empty lines, including their existing spaces, exactly as written.
    if (/[^ \t\r]/u.test(source.slice(from, to))) edits.push({ from, to: from, text: indent });
    from = to + 1;
  }
}

interface ExpectedNode { title: string; parent: number }

function validateConversion(doc: MindDocument, edits: TextEdit[], expected: ExpectedNode[]): void {
  const converted = parseMarkdown(applyEdits(doc.source, edits), doc.root.title, undefined, 'list');
  const positions = new Map(converted.nodes.map((node, index) => [node.id, index]));
  if (converted.nodes.length !== expected.length || converted.nodes.some((node, index) => {
    const original = expected[index];
    const parent = positions.get(node.parentId ?? '') ?? -1;
    return !original || node.title !== original.title || parent !== original.parent
      || (index === 0 ? node.kind !== 'atx' || node.level !== 2 : node.kind !== 'list');
  })) {
    throw new Error('本文の箇条書きなどがノード構造を変えるため、安全に変換できません。Markdown 側で本文とノードを分けてください。');
  }
}

/** Explicit migration only: edit heading ranges and indent existing body lines in place. */
export function planListConversion(doc: MindDocument): TextEdit[] {
  if (doc.format === 'list') return [];
  if (doc.nodes.length === 0) throw new Error('変換する見出しがありません。');
  for (const node of doc.nodes) {
    if (node.kind === 'setext' && /[\r\n]/u.test(node.title)) {
      throw new Error('複数行の Setext 見出しは、Markdown 側で 1 行の見出しへ直してから変換してください。');
    }
  }
  const singleRoot = doc.root.children.length === 1 ? doc.root.children[0] : undefined;
  const edits: TextEdit[] = [];
  const expected: ExpectedNode[] = singleRoot ? [] : [{ title: doc.root.title, parent: -1 }];
  const positions = new Map<string, number>();
  const depths = new Map<string, number>();
  for (const node of doc.nodes) {
    const isRoot = node === singleRoot;
    const parentPosition = positions.get(node.parentId ?? '') ?? (singleRoot ? -1 : 0);
    const depth = isRoot ? -1 : (depths.get(node.parentId ?? '') ?? -1) + 1;
    const prefix = !singleRoot && positions.size === 0 ? `## ${doc.root.title}${doc.eol}${doc.eol}` : '';
    const heading = isRoot ? `## ${node.title}` : `${'  '.repeat(depth)}- ${node.title}`;
    const replacement = prefix + heading;
    if (replacement !== doc.source.slice(node.from, node.headingTo)) {
      edits.push({ from: node.from, to: node.headingTo, text: replacement });
    }
    if (!isRoot) indentBody(doc.source, node, depth, edits);
    positions.set(node.id, expected.length);
    depths.set(node.id, depth);
    expected.push({ title: node.title, parent: isRoot ? -1 : parentPosition });
  }
  validateConversion(doc, edits, expected);
  return edits;
}
