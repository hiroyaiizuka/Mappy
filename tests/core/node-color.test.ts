import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit } from '../../src/core/commands';
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';
import {
  NODE_COLORS, NODE_COLOR_VALUES, colorMark, editableTitle, opaqueOverWhite, recoloredTitle, storedColoredTitle, titleColor,
  uncoloredTitle, withColorOf,
} from '../../src/core/node-color';
import { readTopicPositions, storedTopicPosition, topicKeys } from '../../src/core/topics';
import { locateSubpath } from '../../src/core/subpath';

const YELLOW = '<mark style="background: #FFF3A3A6;">';
const BLUE = '<mark style="background: #ADCCFFA6;">';

function find(doc: MindDocument, title: string): MindNode {
  const node = doc.nodes.find((candidate) => uncoloredTitle(candidate.title) === title);
  if (!node) throw new Error(`Missing node: ${title}`);
  return node;
}

/** The note after colouring the node shown as `title`, and the edits that made it. */
function color(source: string, title: string, to: Parameters<typeof recoloredTitle>[1], format?: MindDocument['format']) {
  const doc = parseMarkdown(source, 'Note', undefined, format);
  const node = title === 'root' ? doc.root : find(doc, title);
  const plan = planEdit(doc, { type: 'color', nodeId: node.id, color: to });
  return { doc, node, plan, after: applyEdits(source, plan.edits) };
}

describe('reading a node colour from its text (LEV-364)', () => {
  it('reads each of the six from the mark the map writes, and Highlightr\'s value as written', () => {
    for (const name of NODE_COLORS) {
      const title = `${colorMark(name)}文字</mark>`;
      expect(titleColor(title)).toEqual({ color: name, value: NODE_COLOR_VALUES[name], open: colorMark(name), close: '</mark>', inner: '文字', suffix: '' });
    }
    expect(colorMark('yellow')).toBe(YELLOW);
  });

  it('reads the six whatever the case, the alpha, the quotes or the other declarations', () => {
    expect(titleColor('<mark style="background: #fff3a3a6;">x</mark>')?.color).toBe('yellow');
    expect(titleColor('<mark style="background: #FFF3A3;">x</mark>')?.color).toBe('yellow');
    expect(titleColor("<MARK style='background-color:#ADCCFF A6'>x</MARK>")?.color).not.toBe('blue');
    expect(titleColor("<mark style='background-color:#ADCCFFA6'>x</mark>")?.color).toBe('blue');
    expect(titleColor('<mark class="hl" style="color: black; background: #FF5582A6 !important">x</mark >')?.color).toBe('red');
  });

  it('draws another colour as written, and nothing that is not a colour', () => {
    expect(titleColor('<mark style="background: #123456;">x</mark>')).toMatchObject({ color: 'custom', value: '#123456' });
    expect(titleColor('<mark style="background: rgb(10, 20, 30);">x</mark>')).toMatchObject({ color: 'custom', value: 'rgb(10, 20, 30)' });
    expect(titleColor('<mark style="background: hsl(120deg 50% 50%);">x</mark>')).toMatchObject({ color: 'custom' });
    expect(titleColor('<mark style="background: rgba(10, 20, 30, 0.5);">x</mark>')).toMatchObject({ color: 'custom' });
    expect(titleColor('<mark style="background: rgb(10 20 30 / 50%);">x</mark>')).toMatchObject({ color: 'custom' });
    // An address, a variable or a word is never handed to the style (a word the browser does not know would leave the
    // box with no fill at all, code review 1): the node reads as Obsidian's highlight instead.
    for (const value of ['url(https://example.com/a.png)', 'var(--text-normal)', 'inherit', 'none', 'red url(x)', 'pink', 'foo', 'transparent', 'rgb(,,)', 'hsl(a, b, c)']) {
      expect(titleColor(`<mark style="background: ${value};">x</mark>`), value).toMatchObject({ color: 'yellow', value: NODE_COLOR_VALUES.yellow });
    }
  });

  it('reads a mark without a background, and Obsidian\'s ==highlight== over the whole text, as yellow', () => {
    expect(titleColor('<mark>x</mark>')).toMatchObject({ color: 'yellow', open: '<mark>', inner: 'x' });
    expect(titleColor('==強調 [[リンク]]==')).toMatchObject({ color: 'yellow', open: '==', close: '==', inner: '強調 [[リンク]]' });
  });

  it('leaves a node uncoloured when the mark or the highlight covers part of its text only', () => {
    for (const title of [
      '前半 <mark>後半</mark>', '<mark>前半</mark> 後半', `${YELLOW}a</mark> b ${BLUE}c</mark>`, '==a== b ==c==', '== a ==', '==a ==',
      '`<mark>`x`</mark>`', '\\<mark>x</mark>', '[[<mark>x</mark>]]', '', 'plain',
      // The closing `==` escaped (code review 1): Markdown shows `==a==` as it is.
      '==a\\==', '==a\\\\\\==',
    ]) expect(titleColor(title), title).toBeNull();
    // An even run of backslashes escapes itself, and the highlight stands.
    expect(titleColor('==a\\\\==')?.inner).toBe('a\\\\');
  });

  it('reads the colour before a block id ending the line, which stays outside it (code review 1)', () => {
    expect(titleColor(`${YELLOW}買い物</mark> ^abc-1`)).toMatchObject({ color: 'yellow', inner: '買い物', close: '</mark>', suffix: ' ^abc-1' });
    expect(titleColor('==買い物== ^abc')).toMatchObject({ color: 'yellow', inner: '買い物', suffix: ' ^abc' });
    expect(titleColor(`${YELLOW}買い物 ^abc</mark>`)).toMatchObject({ inner: '買い物 ^abc', suffix: '' });
    expect(uncoloredTitle(`${YELLOW}買い物</mark> ^abc`)).toBe('買い物');
  });

  it('finds the mark that closes the first one, a mark inside it included', () => {
    const title = `${BLUE}前半 <mark>中</mark> 後半</mark>`;
    expect(titleColor(title)).toMatchObject({ color: 'blue', inner: '前半 <mark>中</mark> 後半' });
    expect(uncoloredTitle(title)).toBe('前半 <mark>中</mark> 後半');
    // Inline code inside: its `</mark>` is text, not the closing tag.
    expect(titleColor(`${YELLOW}a \`</mark>\` b</mark>`)?.inner).toBe('a `</mark>` b');
  });
});

describe('writing a colour over a title (LEV-364)', () => {
  it('wraps, changes and takes off the colour, the text inside kept byte for byte', () => {
    const inner = '**太字** [[ノート#見出し|別名]] ![[図.png]] <br> `code`';
    const yellow = recoloredTitle(inner, 'yellow');
    expect(yellow).toBe(`${YELLOW}${inner}</mark>`);
    expect(recoloredTitle(yellow, 'blue')).toBe(`${BLUE}${inner}</mark>`);
    expect(recoloredTitle(yellow, null)).toBe(inner);
    expect(recoloredTitle(inner, null)).toBe(inner);
  });

  it('writes nothing for the colour the node already shows, a highlight included', () => {
    expect(recoloredTitle('買い物 ^abc', 'blue')).toBe(`${BLUE}買い物</mark> ^abc`);
    expect(recoloredTitle(`${BLUE}買い物</mark> ^abc`, 'yellow')).toBe(`${YELLOW}買い物</mark> ^abc`);
    expect(recoloredTitle(`${BLUE}買い物</mark> ^abc`, null)).toBe('買い物 ^abc');
    expect(recoloredTitle(`${YELLOW}x</mark>`, 'yellow')).toBe(`${YELLOW}x</mark>`);
    expect(recoloredTitle('==x==', 'yellow')).toBe('==x==');
    expect(recoloredTitle('==x==', 'green')).toBe('<mark style="background: #BBFABBA6;">x</mark>');
    expect(recoloredTitle('==x==', null)).toBe('x');
  });

  it('wraps the whole of a title that has a mark over part of it', () => {
    expect(recoloredTitle('前半 <mark>後半</mark>', 'red')).toBe('<mark style="background: #FF5582A6;">前半 <mark>後半</mark></mark>');
    expect(recoloredTitle('<mark style="background: #FF5582A6;">前半 <mark>後半</mark></mark>', null)).toBe('前半 <mark>後半</mark>');
  });

  it('gives the calling item\'s colour, and only that, to the called root\'s text it shows (§5 M12, code review 1)', () => {
    expect(withColorOf('呼ばれた根', `${BLUE}![[map]]</mark>`)).toBe(`${BLUE}呼ばれた根</mark>`);
    expect(withColorOf(`${YELLOW}呼ばれた根</mark>`, `${BLUE}![[map]]</mark>`)).toBe(`${BLUE}呼ばれた根</mark>`);
    // The item has no colour: the called map's colour of its root is not shown, so 色なし is what the menu shows and does.
    expect(withColorOf(`${YELLOW}呼ばれた根</mark>`, '![[map]]')).toBe('呼ばれた根');
    expect(withColorOf('呼ばれた根', '==![[map]]==')).toBe('==呼ばれた根==');
    // A text the item's `==` cannot hold is shown in the same colour as the map's own mark.
    expect(withColorOf('x == y', '==![[map]]==')).toBe(`${YELLOW}x == y</mark>`);
    expect(withColorOf('根', `${BLUE}![[map]]</mark> ^id`)).toBe(`${BLUE}根</mark>`);
  });

  it('gives the inline editor the text inside the colour, and keeps the colour around what it saves', () => {
    const title = `${YELLOW}一行目<br>二行目</mark>`;
    expect(editableTitle(title)).toBe('一行目\n二行目');
    expect(storedColoredTitle('一行目\n二行目', title)).toBe(title);
    expect(storedColoredTitle('新しい名前', title)).toBe(`${YELLOW}新しい名前</mark>`);
    expect(storedColoredTitle('', title)).toBe(`${YELLOW}</mark>`);
    expect(storedColoredTitle('新しい名前', '==古い==')).toBe('==新しい名前==');
    expect(storedColoredTitle('新しい名前', '古い')).toBe('新しい名前');
  });

  it('refuses a draft that would end the colour\'s mark early or leave one open, and writes a highlight it cannot hold as the yellow mark', () => {
    expect(() => storedColoredTitle('a</mark>b', `${YELLOW}x</mark>`)).toThrow('色の印');
    expect(() => storedColoredTitle('<mark>a', `${YELLOW}x</mark>`)).toThrow('色の印');
    expect(storedColoredTitle('前半 <mark>後半</mark>', `${YELLOW}x</mark>`)).toBe(`${YELLOW}前半 <mark>後半</mark></mark>`);
    // Emptied, ending in `=` or holding `==`: no `==` can wrap it (code review 1), so the yellow mark does, never a refusal.
    expect(storedColoredTitle('', '==x==')).toBe(`${YELLOW}</mark>`);
    expect(storedColoredTitle('a=', '==x==')).toBe(`${YELLOW}a=</mark>`);
    expect(storedColoredTitle('a==b', '==x==')).toBe(`${YELLOW}a==b</mark>`);
    expect(storedColoredTitle(' a', '==x==')).toBe('==a==');
    // A block id after the colour stays there.
    expect(storedColoredTitle('新しい', `${YELLOW}古い</mark> ^abc`)).toBe(`${YELLOW}新しい</mark> ^abc`);
  });

  it('lays a colour over white for a drawing', () => {
    expect(opaqueOverWhite('#FFF3A3A6')).toBe('#fff7c3');
    expect(opaqueOverWhite('#ADCCFF')).toBe('#adccff');
    expect(opaqueOverWhite('pink')).toBe('pink');
  });
});

describe('the colour command (LEV-364)', () => {
  const list = '---\nmappy: true\n---\n## 本体\n\n- 子 A\n- [[ノート]] リンク\n  - 孫\n- 同じ\n- 同じ\n- ![[図.png]]\n\n## トピック\n\n- 下\n';

  it('wraps a list item\'s text in one edit over its text, the rest of the note untouched', () => {
    const { node, plan, after } = color(list, '子 A', 'yellow');
    expect(plan.edits).toEqual([{ from: node.titleFrom, to: node.titleTo, text: `${YELLOW}子 A</mark>` }]);
    expect(after).toBe(list.replace('- 子 A', `- ${YELLOW}子 A</mark>`));
    expect(plan.selectionOffset).toBe(node.titleFrom);
  });

  it('changes the colour and takes it off in the same range, back to the note as it was', () => {
    const colored = color(list, '子 A', 'yellow').after;
    const blue = color(colored, '子 A', 'blue');
    expect(blue.plan.edits).toHaveLength(1);
    expect(blue.after).toBe(list.replace('- 子 A', `- ${BLUE}子 A</mark>`));
    expect(color(blue.after, '子 A', null).after).toBe(list);
  });

  it('writes nothing when the node already shows the colour, or has none to take off', () => {
    const colored = color(list, '子 A', 'yellow').after;
    expect(color(colored, '子 A', 'yellow').plan.edits).toEqual([]);
    expect(color(list, '子 A', null).plan.edits).toEqual([]);
  });

  it('colours a link item, an image item and one of two same-named items, each keeping the others and the tree', () => {
    for (const title of ['[[ノート]] リンク', '![[図.png]]']) {
      const { doc, after } = color(list, title, 'green');
      const parsed = parseMarkdown(after, 'Note', doc);
      expect(parsed.nodes.map((node) => uncoloredTitle(node.title))).toEqual(doc.nodes.map((node) => node.title));
      expect(parsed.nodes.filter((node) => titleColor(node.title)?.color === 'green').map((node) => node.title))
        .toEqual([`<mark style="background: #BBFABBA6;">${title}</mark>`]);
    }
    const doc = parseMarkdown(list, 'Note');
    const second = doc.nodes.filter((node) => node.title === '同じ')[1];
    if (!second) throw new Error('Missing the second 同じ');
    const plan = planEdit(doc, { type: 'color', nodeId: second.id, color: 'red' });
    const after = parseMarkdown(applyEdits(list, plan.edits), 'Note', doc, undefined, plan.edits);
    expect(after.nodes.map((node) => node.id)).toEqual(doc.nodes.map((node) => node.id));
    expect(after.nodes.find((node) => node.id === second.id)?.title).toBe('<mark style="background: #FF5582A6;">同じ</mark>');
  });

  it('colours headings of each kind and the body root, the heading marks and the underline left as they are', () => {
    const headings = '# ルート #\n\n## 見出し ##\n\n下線\n---\n\n本文\n';
    expect(color(headings, 'ルート', 'yellow', 'headings').after).toBe(`# ${YELLOW}ルート</mark> #\n\n## 見出し ##\n\n下線\n---\n\n本文\n`);
    expect(color(headings, '見出し', 'yellow', 'headings').after).toBe(`# ルート #\n\n## ${YELLOW}見出し</mark> ##\n\n下線\n---\n\n本文\n`);
    expect(color(headings, '下線', 'yellow', 'headings').after).toBe(`# ルート #\n\n## 見出し ##\n\n${YELLOW}下線</mark>\n---\n\n本文\n`);
  });

  it('colours an empty node: the empty heading and the empty item get an empty mark', () => {
    expect(color('# A\n\n## \n', '', 'yellow', 'headings').after).toBe(`# A\n\n## ${YELLOW}</mark>\n`);
    expect(color('# A\n\n##\n', '', 'yellow', 'headings').after).toBe(`# A\n\n## ${YELLOW}</mark>\n`);
    expect(color('## A\n\n- \n- b\n', '', 'yellow').after).toBe(`## A\n\n- ${YELLOW}</mark>\n- b\n`);
  });

  it('names the file-name root after the file in that colour, as LEV-301 names it, and writes nothing for no colour', () => {
    const source = '---\nmappy: true\n---\n- 項目\n';
    const doc = parseMarkdown(source, 'ファイル名');
    expect(doc.root.kind).toBe('root');
    const plan = planEdit(doc, { type: 'color', nodeId: 'root', color: 'purple' });
    expect(applyEdits(source, plan.edits)).toBe('---\nmappy: true\n---\n\n## <mark style="background: #D2B3FFA6;">ファイル名</mark>\n\n- 項目\n');
    expect(planEdit(doc, { type: 'color', nodeId: 'root', color: null }).edits).toEqual([]);
  });

  it('keeps a free topic\'s key and position: the key is the heading without its colour, so only the heading changes (code review 1)', () => {
    const source = '---\nmappy: true\nmappy-topics:\n  トピック: { mindmap: [120, 40] }\n---\n## 本体\n\n- a\n\n## トピック\n\n- 下\n\n## トピック\n';
    const doc = parseMarkdown(source, 'Note');
    const [topic, second] = projectMap(doc).topics;
    if (!topic || !second) throw new Error('Missing topics');
    const plan = planEdit(doc, { type: 'color', nodeId: topic.id, color: 'yellow' });
    expect(plan.edits).toEqual([{ from: topic.titleFrom, to: topic.titleTo, text: `${YELLOW}トピック</mark>` }]);
    const after = parseMarkdown(applyEdits(source, plan.edits), 'Note', doc, undefined, plan.edits);
    expect(topicKeys(after)).toEqual(topicKeys(doc));
    expect(topicKeys(after).get(second.id)).toBe('トピック (2)');
    expect(storedTopicPosition(readTopicPositions(after.source), topicKeys(after), { id: topic.id, title: `${YELLOW}トピック</mark>` }, 'mindmap')).toEqual({ x: 120, y: 40 });
    // Coloured in Markdown, the same: nothing to rekey.
    const byHand = source.replace('## トピック\n\n- 下', '## ==トピック==\n\n- 下');
    const hand = parseMarkdown(byHand, 'Note');
    const handTopic = projectMap(hand).topics[0];
    expect(storedTopicPosition(readTopicPositions(byHand), topicKeys(hand), handTopic ?? { id: '', title: '' }, 'mindmap')).toEqual({ x: 120, y: 40 });
    // A key a Highlightr user's coloured heading had (the heading as written) is still read.
    const legacy = `---\nmappy: true\nmappy-topics:\n  "${YELLOW.replace(/"/gu, '\\"')}古い</mark>": { mindmap: [7, 8] }\n---\n## 本体\n\n## ${YELLOW}古い</mark>\n`;
    const old = parseMarkdown(legacy, 'Note');
    const oldTopic = projectMap(old).topics[0];
    expect(storedTopicPosition(readTopicPositions(legacy), topicKeys(old), oldTopic ?? { id: '', title: '' }, 'mindmap')).toEqual({ x: 7, y: 8 });
  });

  it('colours an item with a block id, the id left at the end of the line so links to it still find it (code review 1)', () => {
    const source = '## 本体\n\n- 買い物 ^abc123\n- 次\n';
    const { after } = color(source, '買い物 ^abc123', 'red');
    expect(after).toBe('## 本体\n\n- <mark style="background: #FF5582A6;">買い物</mark> ^abc123\n- 次\n');
    expect(locateSubpath(after, '#^abc123')).toBe(after.indexOf('- <mark'));
    const doc = parseMarkdown(after, 'Note');
    const node = find(doc, '買い物');
    expect(applyEdits(after, planEdit(doc, { type: 'rename', nodeId: node.id, title: '買い出し' }).edits)).toBe(after.replace('>買い物<', '>買い出し<'));
    expect(color(after, '買い物', null).after).toBe(source);
  });

  it('keeps the colour through a rename, never twice, and refuses a draft that would break it', () => {
    const colored = color(list, '子 A', 'blue').after;
    const doc = parseMarkdown(colored, 'Note');
    const node = find(doc, '子 A');
    const rename = planEdit(doc, { type: 'rename', nodeId: node.id, title: '名前を変えた' });
    expect(applyEdits(colored, rename.edits)).toBe(list.replace('- 子 A', `- ${BLUE}名前を変えた</mark>`));
    expect(planEdit(doc, { type: 'rename', nodeId: node.id, title: editableTitle(node.title) }).edits).toEqual([
      { from: node.titleFrom, to: node.titleTo, text: node.title },
    ]);
    expect(() => planEdit(doc, { type: 'rename', nodeId: node.id, title: 'a</mark>b' })).toThrow('色の印');
  });

  it('refuses the root of a headings note like the other edits the root has none of', () => {
    const doc = parseMarkdown('# A\n', 'Note', undefined, 'headings');
    expect(() => planEdit(doc, { type: 'color', nodeId: 'root', color: 'yellow' })).toThrow('ルート');
  });
});

describe('the colours on screen (styles.css, LEV-364)', () => {
  const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
  /** WCAG 2 relative luminance of `#rrggbb`. */
  const luminance = (hex: string): number => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
  };

  it('draws each of the six as written in the light theme and as a darker colour in the dark one', () => {
    for (const name of NODE_COLORS) {
      const fallback = new RegExp(`\\[data-mappy-color="${name}"\\] \\{ background: (#[0-9A-F]{8}); \\}`, 'u').exec(css)?.[1];
      const pair = new RegExp(`\\[data-mappy-color="${name}"\\] \\{ background: light-dark\\((#[0-9A-F]{8}), (#[0-9A-F]{6})\\); \\}`, 'u').exec(css);
      expect([name, fallback, pair?.[1]]).toEqual([name, NODE_COLOR_VALUES[name], NODE_COLOR_VALUES[name]]);
      // Obsidian's default text: #222222 on the light page, #dadada on the dark one (AA: 4.5).
      expect([name, contrast(opaqueOverWhite(NODE_COLOR_VALUES[name]), '#222222') >= 4.5]).toEqual([name, true]);
      expect([name, contrast(pair?.[2] ?? '#000000', '#dadada') >= 4.5]).toEqual([name, true]);
    }
  });

  it('never looks at the body\'s theme class: the element\'s colour scheme decides, so the map\'s own theme (M14) holds', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '').split('\n').filter((line) => line.includes('data-mappy-color'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/theme-(?:light|dark)/u);
  });
});
