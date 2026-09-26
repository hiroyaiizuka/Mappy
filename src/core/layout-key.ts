import type { TextEdit } from './commands';
import type { LayoutMode } from './layout-mode';
import { LAYOUT_KEY, MAPPY_KEY } from './map-keys';
import { frontmatterLayout } from './markdown';
import { locateFrontmatterKey, parseYamlValue } from './yaml-lite';

const BOM = 0xfeff;

/**
 * The edits that make a map note's frontmatter ask for `layout` (a layout button, LEV-196): `mappy: true`, and
 * `mappy-layout` for any layout but the regular map, whose key is removed instead (the same keys
 * `writeMapLayout` sets). Only those keys' lines change; every other key keeps its bytes. Planned on the text
 * itself, so the write can go through the map's own save path (`DocumentStore`) instead of beside it: the edits
 * are the view's own, and the re-read after them carries every node's id (LEV-146, LEV-150). Empty when the note
 * already asks for `layout`.
 */
export function planMapLayout(source: string, layout: LayoutMode): TextEdit[] {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const header = frontmatterLayout(source);
  const layoutLine = layout === 'mindmap' ? '' : `${LAYOUT_KEY}: ${layout}${eol}`;
  const mappyLine = `${MAPPY_KEY}: true${eol}`;
  if (!header) {
    const bom = source.charCodeAt(0) === BOM ? 1 : 0;
    return [{ from: bom, to: bom, text: `---${eol}${mappyLine}${layoutLine}---${eol}` }];
  }
  if (!header.closed) throw new Error('先に Markdown 側で frontmatter を閉じてください。');
  const edits: TextEdit[] = [];
  const mappy = locateFrontmatterKey(source, header, MAPPY_KEY);
  if (!mappy) edits.push({ from: header.closingFrom, to: header.closingFrom, text: mappyLine });
  else if (parseYamlValue(mappy.inline, mappy.nested) !== true) edits.push({ from: mappy.from, to: mappy.to, text: mappyLine });
  const current = locateFrontmatterKey(source, header, LAYOUT_KEY);
  if (!current) {
    if (layoutLine) edits.push({ from: header.closingFrom, to: header.closingFrom, text: layoutLine });
  } else if (!layoutLine) {
    edits.push({ from: current.from, to: current.to, text: '' });
  } else if (normalized(parseYamlValue(current.inline, current.nested)) !== layout) {
    edits.push({ from: current.from, to: current.to, text: layoutLine });
  }
  // Two insertions before the closing line are one edit, the identity marker first.
  edits.sort((left, right) => left.from - right.from);
  return edits.reduce<TextEdit[]>((merged, edit) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.from === previous.to && edit.from === edit.to && previous.from === edit.from) previous.text += edit.text;
    else merged.push({ ...edit });
    return merged;
  }, []);
}

/** A value as the readers take it (`layoutFromValue`), without turning an unknown one into the regular map. */
function normalized(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
