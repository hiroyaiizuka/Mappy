export interface WikiLinkContext {
  from: number;
  to: number;
  query: string;
  suffix: string;
}

/** Find the file-name portion of the unclosed wiki link at the cursor. */
export function wikiLinkContext(value: string, cursor: number): WikiLinkContext | null {
  const prefix = value.slice(0, cursor);
  const from = prefix.lastIndexOf("[[");
  if (from < 0) return null;
  const query = prefix.slice(from + 2);
  if (/[[\]\n\r#|]/u.test(query)) return null;
  const before = value.slice(0, from);
  if ((before.match(/\\+$/u)?.[0].length ?? 0) % 2 !== 0) return null;
  let code = "";
  for (const match of before.matchAll(/`+/gu)) {
    if (!code) code = match[0];
    else if (code === match[0]) code = "";
  }
  if (code) return null;
  const after = value.slice(cursor);
  const closing = after.indexOf("]]");
  const remainder = closing < 0 ? "" : after.slice(0, closing);
  const hasClosing = closing >= 0 && !/[[\]\n\r]/u.test(remainder);
  const separator = hasClosing ? remainder.search(/[#|]/u) : -1;
  return {
    from,
    to: hasClosing ? cursor + closing + 2 : cursor,
    query,
    suffix: separator >= 0 ? remainder.slice(separator) : "",
  };
}

export function insertWikiLink(value: string, context: WikiLinkContext, linktext: string, alias?: string): { value: string; cursor: number } {
  const suffix = context.suffix || (alias ? `|${alias}` : "");
  const replacement = `[[${linktext}${suffix}]]`;
  return {
    value: value.slice(0, context.from) + replacement + value.slice(context.to),
    cursor: context.from + replacement.length,
  };
}

/** `[[note#heading|alias]]`, `note|alias` or `figure.png|120` → the linkpath alone; null when nothing is left. */
export function wikiLinkPath(link: string | null | undefined): string | null {
  if (!link) return null;
  const trimmed = link.trim();
  const value = trimmed.match(/^!?\[\[([\s\S]+)\]\]$/u)?.[1] ?? trimmed;
  const path = value.split("|", 1)[0]?.split("#", 1)[0]?.split("^", 1)[0]?.trim();
  return path || null;
}

/** The scheme a link is written with, lower case, or null for a vault path. One parser for both readers below. */
export function urlScheme(text: string): string | null {
  return text.match(/^([A-Za-z][A-Za-z0-9+.-]*):/u)?.[1]?.toLowerCase() ?? null;
}

/** `https://…`, `app://…`, `data:…`: a URL with a scheme, as opposed to a vault path. */
export function hasUrlScheme(text: string): boolean {
  return urlScheme(text) !== null;
}

/**
 * The schemes a link written in a note may keep when it leaves for another plugin's document.
 * `obsidian:` is on the list because a vault link is what it usually is, and clicking one in the map
 * view does the same thing; the rest of the world's schemes are left out on purpose (see `externalUrl`).
 */
const EXTERNAL_LINK_SCHEMES = new Set(["http", "https", "mailto", "obsidian"]);

/**
 * A note's link as an external URL, or null when its scheme is not on the short allowed list. The list
 * is an allowlist, not a list of known-bad schemes: a link copied out of a note lands in a document
 * another plugin opens (an Excalidraw drawing), where a click runs it, so `javascript:` and `data:` must
 * not travel — and so must nothing else that turns out to run. The cost is that a link Obsidian would
 * have opened (`tel:`, `zotero:`, `vscode:`) is dropped instead; the caller says so rather than
 * dropping it silently.
 */
export function externalUrl(text: string): string | null {
  const scheme = urlScheme(text);
  return scheme && EXTERNAL_LINK_SCHEMES.has(scheme) ? text : null;
}
