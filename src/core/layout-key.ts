import type { TextEdit } from './commands';
import { layoutKeyValue, parseLayout, type LayoutMode } from './layout-mode';
import { LAYOUT_KEY } from './map-keys';
import { frontmatterLayout } from './markdown';
import { locateFrontmatterKey, parseYamlValue } from './yaml-lite';

const BOM = 0xfeff;

/**
 * The edit that makes a note's frontmatter ask for `layout` (a layout button, LEV-196): `mappy-layout` set, or
 * removed for the regular map — the value `writeMapLayout` writes (`layoutKeyValue`). Only that key's lines
 * change; every other key keeps its bytes, and `mappy` is left as it is: the button records a preference, it
 * does not make a note a map (the explicit conversion does), so a button write queued behind 「マインドマップ化を
 * 解除」 cannot bring the marker back. Planned on the text itself, so the write can go through the map's own save
 * path (`DocumentStore`) instead of beside it: the edits are the view's own, and the re-read after them carries
 * every node's id (LEV-146, LEV-150). Empty when the note already asks for `layout`.
 */
export function planMapLayout(source: string, layout: LayoutMode): TextEdit[] {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const value = layoutKeyValue(layout);
  const line = value ? `${LAYOUT_KEY}: ${value}${eol}` : '';
  const header = frontmatterLayout(source);
  if (!header) {
    const bom = source.charCodeAt(0) === BOM ? 1 : 0;
    return line ? [{ from: bom, to: bom, text: `---${eol}${line}---${eol}` }] : [];
  }
  if (!header.closed) throw new Error('先に Markdown 側で frontmatter を閉じてください。');
  const current = locateFrontmatterKey(source, header, LAYOUT_KEY);
  if (!current) return line ? [{ from: header.closingFrom, to: header.closingFrom, text: line }] : [];
  if (!line) return [{ from: current.from, to: current.to, text: '' }];
  return parseLayout(parseYamlValue(current.inline, current.nested)) === layout ? [] : [{ from: current.from, to: current.to, text: line }];
}
