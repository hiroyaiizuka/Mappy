/**
 * What a screen reader reads for an element, for the parts of the accessible-name computation Mappy uses:
 * `aria-labelledby` (its targets' text, joined by a space, hidden targets included — they are referenced
 * directly), else `aria-label`. A map node carries no `aria-label` (Obsidian draws one as a tooltip over the
 * node below, LEV-199), so the tests find nodes by this name rather than by the attribute.
 */
export function accessibleName(element: Element): string {
  return referenced(element, 'aria-labelledby') ?? element.getAttribute('aria-label') ?? '';
}

/** The description read after the name: `aria-describedby`'s targets' text, else `aria-description`. */
export function accessibleDescription(element: Element): string {
  return referenced(element, 'aria-describedby') ?? element.getAttribute('aria-description') ?? '';
}

/** The first map node under `root` whose name is this text (what `.mappy-node[aria-label="…"]` used to find). */
export function nodeNamed(root: ParentNode, name: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>('.mappy-node')).find(node => accessibleName(node) === name) ?? null;
}

function referenced(element: Element, attribute: string): string | null {
  const ids = element.getAttribute(attribute)?.split(/\s+/u).filter(Boolean);
  if (!ids?.length) return null;
  const root = element.getRootNode() as Document | Element;
  return ids.map(id => {
    const target = element.ownerDocument.getElementById(id) ?? root.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!target) throw new Error(`${attribute} points to a missing element: ${id}`);
    return target.textContent?.trim() ?? '';
  }).join(' ');
}
