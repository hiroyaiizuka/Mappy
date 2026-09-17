export interface WikiLinkContext {
  from: number;
  to: number;
  query: string;
  suffix: string;
}

/** Find the file-name portion of the unclosed wiki link at the cursor. */
export function wikiLinkContext(value: string, cursor: number): WikiLinkContext | null {
  const prefix = value.slice(0, cursor);
  const from = prefix.lastIndexOf('[[');
  if (from < 0) return null;
  const query = prefix.slice(from + 2);
  if (/[[\]\n\r#|]/u.test(query)) return null;
  const before = value.slice(0, from);
  if ((before.match(/\\+$/u)?.[0].length ?? 0) % 2 !== 0) return null;
  let code = '';
  for (const match of before.matchAll(/`+/gu)) {
    if (!code) code = match[0];
    else if (code === match[0]) code = '';
  }
  if (code) return null;
  const after = value.slice(cursor);
  const closing = after.indexOf(']]');
  const remainder = closing < 0 ? '' : after.slice(0, closing);
  const hasClosing = closing >= 0 && !/[[\]\n\r]/u.test(remainder);
  const separator = hasClosing ? remainder.search(/[#|]/u) : -1;
  return {
    from,
    to: hasClosing ? cursor + closing + 2 : cursor,
    query,
    suffix: separator >= 0 ? remainder.slice(separator) : '',
  };
}

export function insertWikiLink(value: string, context: WikiLinkContext, linktext: string, alias?: string): { value: string; cursor: number } {
  const suffix = context.suffix || (alias ? `|${alias}` : '');
  const replacement = `[[${linktext}${suffix}]]`;
  return {
    value: value.slice(0, context.from) + replacement + value.slice(context.to),
    cursor: context.from + replacement.length,
  };
}
