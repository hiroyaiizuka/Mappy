import type { TopicPosition } from '../../src/core/topics';
import type { MindmapView } from '../../src/ui/mindmap-view';

/**
 * Where a press at (`x`, `y`) on the canvas (its own pixels, from its top-left corner) is stored in `mappy-topics`: map
 * units from the body root's top-left, whole numbers. Read before the press, from the viewport and the layout then.
 */
export function pressedPoint(view: MindmapView, x: number, y: number): TopicPosition {
  const viewport = view.getState().viewport as { x: number; y: number; scale: number };
  const origin = (view as unknown as { layout?: { origin: TopicPosition } }).layout?.origin ?? { x: 0, y: 0 };
  return { x: Math.round((x - viewport.x) / viewport.scale - origin.x), y: Math.round((y - viewport.y) / viewport.scale - origin.y) };
}

/**
 * The note as adding a free topic on the map leaves it (LEV-332): `source` with the section `heading` at its end and, in
 * the same step, `point` under `key` for `layout` in `mappy-topics`: at the end of that block when the front matter has
 * one, else as a new key at the end of the front matter, or in a front matter of its own when there is none.
 */
export function withAddedTopic(source: string, topic: { heading: string; key: string; layout: string; point: TopicPosition }): string {
  const entry = `  ${topic.key}: { ${topic.layout}: [${topic.point.x}, ${topic.point.y}] }\n`;
  const body = `${source}\n${topic.heading}\n`;
  if (!source.startsWith('---\n')) return `---\nmappy-topics:\n${entry}---\n${body}`;
  const closing = source.indexOf('\n---\n', 3) + 1;
  const block = /^mappy-topics:\n(?: {2}.*\n)*/mu.exec(source.slice(0, closing));
  const at = block ? block.index + block[0].length : closing;
  return `${body.slice(0, at)}${block ? '' : 'mappy-topics:\n'}${entry}${body.slice(at)}`;
}
