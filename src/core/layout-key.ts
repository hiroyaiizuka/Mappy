import type { TextEdit } from './commands';
import { layoutKeyValue, parseLayout, type LayoutMode } from './layout-mode';
import { readMapFromSource } from './embed';
import { LAYOUT_KEY } from './map-keys';
import { frontmatterLayout } from './markdown';
import { locateFrontmatterKey, parseYamlValue } from './yaml-lite';

/**
 * The edit that makes a map note's frontmatter ask for `layout` (a layout button, LEV-196): `mappy-layout` set,
 * or removed for the regular map — the value `writeMapLayout` writes (`layoutKeyValue`). Only that key's lines
 * change; every other key keeps its bytes. A note that is not a map (`readMapFromSource`: no `mappy: true`, or an
 * Excalidraw drawing) gets nothing: the button records a preference of a map, it does not make one (the explicit
 * conversion does), so a button pressed on a
 * note 「マインドマップ化を解除」 has just released neither brings the marker back nor leaves a layout behind for the
 * next conversion to pick up. Planned on the text itself, so the write can go through the map's own save path
 * (`DocumentStore`) instead of beside it: the edits are the view's own, and the re-read after them carries every
 * node's id (LEV-146, LEV-150). Empty when there is nothing to change.
 */
export function planMapLayout(source: string, layout: LayoutMode): TextEdit[] {
  const header = frontmatterLayout(source);
  if (!header || readMapFromSource(source) === null) return [];
  const value = layoutKeyValue(layout);
  const line = value ? `${LAYOUT_KEY}: ${value}${source.includes('\r\n') ? '\r\n' : '\n'}` : '';
  const current = locateFrontmatterKey(source, header, LAYOUT_KEY);
  if (!current) return line ? [{ from: header.closingFrom, to: header.closingFrom, text: line }] : [];
  if (!line) return [{ from: current.from, to: current.to, text: '' }];
  return parseLayout(parseYamlValue(current.inline, current.nested)) === layout ? [] : [{ from: current.from, to: current.to, text: line }];
}
