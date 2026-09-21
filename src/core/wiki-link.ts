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

/** Deleted from a URL wherever it appears: a reader takes `java\tscript:…` as `javascript:…`. */
const URL_STRIPPED = /[\t\n\r]/gu;

/** The controls and spaces a reader trims from both ends of a URL before it reads the scheme. */
function isUrlBlank(code: number): boolean {
  return code <= 0x20 || code === 0x7f;
}

/**
 * A link as its reader will see it. A browser deletes every tab and line break inside a URL and trims the
 * C0 controls and spaces around it before it reads the scheme, and the writers a copied link passes through
 * drop the same characters, so ` javascript:…` and `java&#9;script:…` reach a click as `javascript:…`. Reading
 * the scheme from anything else would let a space hide it from the allowed list below.
 */
function urlText(text: string): string {
  const value = text.replace(URL_STRIPPED, '');
  let start = 0;
  let end = value.length;
  while (start < end && isUrlBlank(value.charCodeAt(start))) start += 1;
  while (end > start && isUrlBlank(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/** The scheme a link is written with, lower case, or null for a vault path. One parser for both readers below. */
export function urlScheme(text: string): string | null {
  return urlText(text).match(/^([A-Za-z][A-Za-z0-9+.-]*):/u)?.[1]?.toLowerCase() ?? null;
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
 * dropping it silently. What travels is the URL its reader will see (`urlText`), so a link cannot be
 * judged in one form and written in another.
 */
export function externalUrl(text: string): string | null {
  const value = urlText(text);
  const scheme = urlScheme(value);
  return scheme && EXTERNAL_LINK_SCHEMES.has(scheme) ? value : null;
}

/**
 * How a link was written, which decides what a copy of it may become. `[[…]]` and `[見て](path)` name
 * something in the vault, so they keep naming it; an `autolink` is text GFM read as a link on its own,
 * and only there does a string with no scheme mean the web rather than a path.
 */
export type LinkSyntax = 'vault' | 'autolink';

/** GFM reads a web address with no scheme as a link too, leaving the scheme to whoever opens it. */
const WWW_AUTOLINK = /^www\./iu;

/** And an address: `someone@example.com`, with no `mailto:` in front of it. */
const ADDRESS_AUTOLINK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * An autolink as the URL it opens: `www.example.com/a` → `https://www.example.com/a`; anything else comes
 * back as written.
 *
 * Only what the parser called an autolink may be passed. `[[www.example.com]]` and `[見て](www.example.com/a)`
 * are vault paths to Obsidian and must keep naming the note they name; a `www.` autolink is the one syntax
 * where a scheme-less string means the web. Read as written it is a vault path, so a copy of it that leaves
 * the note links to a note that does not exist (LEV-134). The scheme written here is `https:` where GFM's own
 * rule is `http:`: the copy is a new document rather than a transcript of the note, and its link opening
 * matters more than its scheme matching the one the reader of the note would have supplied.
 *
 * GFM also autolinks a bare address (`someone@example.com`), and that one is not decided here: it reads an
 * attachment named the way a retina image is (`file@2x.png`) as an address too, and only the vault knows
 * which it is. `addressUrl` is what the caller reaches for once the vault has had its say.
 */
export function autolinkUrl(text: string): string {
  return !hasUrlScheme(text) && WWW_AUTOLINK.test(text) ? `https://${text}` : text;
}

/**
 * A bare address autolink as the URL it opens (`someone@example.com` → `mailto:someone@example.com`), or
 * null when the text is not one.
 *
 * Pass only an autolink the vault could not place. GFM calls `file@2x.png` an address as readily as it
 * calls `someone@example.com` one, and that first one is a picture a note links to; a copy of it must
 * keep reaching the picture, so the file in the vault decides first and this decides the rest (LEV-138).
 */
export function addressUrl(text: string): string | null {
  return !hasUrlScheme(text) && ADDRESS_AUTOLINK.test(text) ? `mailto:${text}` : null;
}

/**
 * The link a file written out of a note may keep (§5 M13), or null when it may not. A vault link travels as
 * written — inside Obsidian it is the note's own link, outside it reaches nothing — and a link with a scheme
 * travels only when `externalUrl` allows it: a written-out SVG is opened away from Obsidian, by a browser
 * that runs `javascript:` on a click as readily as it opens `https:`. `//host/path` names no scheme and no
 * note either; it would take a file served over http(s) straight out to that host, so it does not travel.
 *
 * The cost, as on the Excalidraw side: a note whose name begins with letters and a colon reads as a scheme
 * and loses its link. Obsidian does not allow `:` in a file name, so this can only be a link written by hand
 * to a note that cannot exist.
 */
export function exportedLink(text: string): string | null {
  const value = urlText(text);
  if (!value) return null;
  if (hasUrlScheme(value)) return externalUrl(value);
  return value.startsWith('//') ? null : value;
}
