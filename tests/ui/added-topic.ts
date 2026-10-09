import { readTopicPositions } from '../../src/core/topics';

/**
 * The note as adding a free topic on the map leaves it (LEV-332): `source` with the section `heading` at its end and,
 * in the same step, the point pressed under `key` for `layout` in `mappy-topics` (made or extended at the end of the
 * front matter). The point is read back from `written`, the note as the view wrote it, since where the canvas was
 * pressed depends on the viewport; everything else is spelled out, so a byte out of place still fails.
 */
export function withAddedTopic(source: string, written: string, topic: { heading: string; key: string; layout: string }): string {
  const point = readTopicPositions(written).get(topic.key)?.[topic.layout];
  if (!point) throw new Error(`No ${topic.layout} position for ${topic.key} in the note`);
  const entry = `  ${topic.key}: { ${topic.layout}: [${point.x}, ${point.y}] }\n`;
  const body = `${source}\n${topic.heading}\n`;
  if (!source.startsWith('---\n')) return `---\nmappy-topics:\n${entry}---\n${body}`;
  const closing = source.indexOf('\n---\n', 3) + 1;
  const header = source.slice(0, closing);
  const entries = readTopicPositions(source).size > 0 ? entry : `mappy-topics:\n${entry}`;
  return `${header}${entries}${body.slice(closing)}`;
}
