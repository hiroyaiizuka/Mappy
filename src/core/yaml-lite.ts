import type { FrontmatterLayout } from './markdown';

/**
 * A deliberately small YAML reader for Mappy's own frontmatter keys. It accepts
 * the flow style Mappy writes and the block style Obsidian's Properties editor
 * rewrites it into. It is not a general YAML parser; unknown syntax degrades to
 * plain strings or null and never throws, so a malformed key only loses topic positions.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface YamlLine { indent: number; text: string }

const sequenceItem = /^-(?:[ \t]|$)/u;
const mappingEntry = /^(?!-(?:[ \t]|$))("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{}[\],][^:]*?)[ \t]*:(?:[ \t]+(.*))?$/u;

function unquote(text: string): string {
  if (/^"(?:[^"\\]|\\.)*"$/u.test(text)) {
    return text.slice(1, -1).replace(/\\(.)/gu, (_match, char: string) => char === 'n' ? '\n' : char === 't' ? '\t' : char);
  }
  if (/^'(?:[^']|'')*'$/u.test(text)) return text.slice(1, -1).replace(/''/gu, "'");
  return text;
}

function scalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (/^["']/u.test(trimmed)) return unquote(trimmed);
  const plain = trimmed.replace(/(?:^|[ \t])#.*$/u, '').trim();
  if (plain === '' || plain === '~' || plain === 'null') return null;
  if (plain === 'true') return true;
  if (plain === 'false') return false;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u.test(plain)) return Number(plain);
  return plain;
}

/** Flow collections: `{ a: [1, 2], "b": 'c' }`. Stops quietly at unexpected input. */
class FlowReader {
  private index = 0;

  constructor(private readonly text: string) {}

  value(): YamlValue {
    this.skip();
    const char = this.text.charAt(this.index);
    if (char === '{') return this.mapping();
    if (char === '[') return this.sequence();
    if (char === '"' || char === "'") return unquote(this.quoted(char));
    return scalar(this.plain(',]}'));
  }

  private mapping(): { [key: string]: YamlValue } {
    const result: { [key: string]: YamlValue } = {};
    this.index++;
    while (this.index < this.text.length) {
      this.skip();
      const char = this.text.charAt(this.index);
      if (char === '}') { this.index++; break; }
      if (char === ',') { this.index++; continue; }
      const key = char === '"' || char === "'" ? unquote(this.quoted(char)) : this.plain(':,}').trim();
      this.skip();
      if (this.text.charAt(this.index) !== ':') break;
      this.index++;
      result[key] = this.value();
    }
    return result;
  }

  private sequence(): YamlValue[] {
    const items: YamlValue[] = [];
    this.index++;
    while (this.index < this.text.length) {
      this.skip();
      const char = this.text.charAt(this.index);
      if (char === ']') { this.index++; break; }
      if (char === ',') { this.index++; continue; }
      items.push(this.value());
    }
    return items;
  }

  private quoted(quote: string): string {
    const start = this.index;
    this.index++;
    while (this.index < this.text.length) {
      const char = this.text.charAt(this.index);
      if (quote === '"' && char === '\\') this.index += 2;
      else if (char === quote) {
        if (quote === "'" && this.text.charAt(this.index + 1) === "'") this.index += 2;
        else { this.index++; break; }
      } else this.index++;
    }
    return this.text.slice(start, this.index);
  }

  private plain(terminators: string): string {
    const start = this.index;
    while (this.index < this.text.length && !terminators.includes(this.text.charAt(this.index))) this.index++;
    return this.text.slice(start, this.index);
  }

  private skip(): void {
    while (/\s/u.test(this.text.charAt(this.index))) this.index++;
  }
}

function inline(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return new FlowReader(trimmed).value();
  return scalar(trimmed);
}

function yamlLines(lines: string[]): YamlLine[] {
  const result: YamlLine[] = [];
  for (const raw of lines) {
    const text = raw.replace(/^[ \t]+/u, '').replace(/[ \t\r]+$/u, '');
    if (!text || text.startsWith('#')) continue;
    result.push({ indent: raw.length - raw.replace(/^[ \t]+/u, '').length, text });
  }
  return result;
}

function block(lines: YamlLine[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];
  if (!first) return { value: null, next: start };
  if (sequenceItem.test(first.text)) {
    const items: YamlValue[] = [];
    let index = start;
    for (let line = lines[index]; line && line.indent === indent && sequenceItem.test(line.text); line = lines[index]) {
      const rest = line.text.slice(1).trim();
      index++;
      const nested = lines[index];
      if (rest) items.push(inline(rest));
      else if (nested && nested.indent > indent) {
        const child = block(lines, index, nested.indent);
        items.push(child.value);
        index = child.next;
      } else items.push(null);
    }
    return { value: items, next: index };
  }
  if (mappingEntry.test(first.text)) {
    const result: { [key: string]: YamlValue } = {};
    let index = start;
    for (let line = lines[index]; line && line.indent === indent; line = lines[index]) {
      const match = mappingEntry.exec(line.text);
      if (!match?.[1]) break;
      const rest = match[2]?.trim() ?? '';
      index++;
      const nested = lines[index];
      if (rest) result[unquote(match[1])] = inline(rest);
      else if (nested && (nested.indent > indent || (nested.indent === indent && sequenceItem.test(nested.text)))) {
        const child = block(lines, index, nested.indent);
        result[unquote(match[1])] = child.value;
        index = child.next;
      } else result[unquote(match[1])] = null;
    }
    return { value: result, next: index };
  }
  return { value: inline(first.text), next: start + 1 };
}

/** Parse a key's value given its inline remainder and the indented lines below it. */
export function parseYamlValue(inlineText: string, nestedLines: string[]): YamlValue {
  if (inlineText.trim()) return inline(inlineText);
  const lines = yamlLines(nestedLines);
  const first = lines[0];
  return first ? block(lines, 0, first.indent).value : null;
}

export interface FrontmatterKeyBlock {
  /** Start of the key's line. */
  from: number;
  /** Offset after the EOL of the last non-blank value line. */
  to: number;
  inline: string;
  nested: string[];
}

function lineAt(source: string, offset: number, limit: number): { text: string; next: number } {
  const newline = source.indexOf('\n', offset);
  const end = newline === -1 || newline >= limit ? limit : newline;
  return { text: source.slice(offset, end).replace(/\r$/u, ''), next: end === limit ? limit : newline + 1 };
}

/** Find a top-level key and the lines that make up its value, without touching other keys. */
export function locateFrontmatterKey(source: string, layout: FrontmatterLayout, key: string): FrontmatterKeyBlock | null {
  const pattern = new RegExp(`^(["']?)${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\1[ \\t]*:(?:[ \\t]+(.*))?$`, 'u');
  let offset = layout.bodyFrom;
  while (offset < layout.closingFrom) {
    const line = lineAt(source, offset, layout.closingFrom);
    const match = pattern.exec(line.text);
    if (match) {
      const inlineText = (match[2] ?? '').trim();
      const nested: string[] = [];
      let to = line.next;
      let cursor = line.next;
      while (cursor < layout.closingFrom) {
        const value = lineAt(source, cursor, layout.closingFrom);
        const indented = /^[ \t]/u.test(value.text) || (!inlineText && sequenceItem.test(value.text));
        if (!indented && value.text.trim() !== '') break;
        nested.push(value.text);
        if (indented) to = value.next;
        cursor = value.next;
      }
      while (nested.length > 0 && nested[nested.length - 1]?.trim() === '') nested.pop();
      return { from: offset, to, inline: inlineText, nested };
    }
    offset = line.next;
  }
  return null;
}
