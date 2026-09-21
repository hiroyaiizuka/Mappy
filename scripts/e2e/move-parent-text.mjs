/**
 * E19 (docs/harness.md): a list item ("はじめに") with its own body both before and after its child
 * list. Moving a child with ⌥↑／⌥↓ must not carry the parent's trailing text away with it, and must
 * not reach past the child list into the parent's own siblings. `src/core/list-commands.ts`'s `move()`
 * swaps only the two neighbouring children's own `from`/`to` spans, which sit inside the parent's span
 * but end before its trailing text — this case drives that through the real keyboard.
 *
 * The trailing text only parses as the parent's own body, rather than lazy-continuing the last child's
 * paragraph (CommonMark), when a blank line separates it from the child list — the fixture keeps that
 * blank line for that reason.
 *
 * Also checks the row's other half: attaching an image to the parent does not touch the child list or
 * the trailing text (`attachImage`/`planAppendBody` write just before the first child).
 *
 * Usage: npm run harness:e2e:move-parent-text -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, installedVersion, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish } from './case-runner.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-move-parent-text.md';
const TRAILING = '子リストの後の本文です。前後の文が入れ替わりで消えないことを確認します。';
const LEADING = '子リストの前の本文です。';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 親本文を挟む移動の確認', '',
  '- はじめに',
  `  ${LEADING}`, '',
  '  - 学ぶこと',
  '  - 全体の流れ', '',
  `  ${TRAILING}`,
  '- 記録する',
  '  - 毎日のログ', '',
].join('\n');
const PNG = 'new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,120,0,0,0,80,8,2,0,0,0,93,249,38,222,0,0,0,154,73,68,65,84,120,218,237,221,65,13,0,48,8,4,65,28,85,26,86,113,212,138,128,144,62,230,178,10,198,192,197,181,149,5,2,208,160,173,9,125,178,52,24,104,208,160,5,26,52,104,208,160,65,11,52,104,208,160,65,131,22,104,208,160,65,131,6,45,208,160,65,131,6,13,90,160,65,131,6,13,26,180,64,131,6,13,26,52,104,129,6,13,26,52,104,208,2,13,26,52,104,208,160,5,26,52,104,208,160,65,11,52,104,208,160,65,131,22,104,208,160,65,131,6,45,208,160,65,131,6,13,90,160,65,131,6,13,26,180,64,131,6,13,122,31,218,60,11,129,54,208,95,237,1,30,135,250,163,100,147,87,160,0,0,0,0,73,69,78,68,174,66,96,130])';

const VIEW = `const leaf = window.__mappyE2E; const view = leaf.view; const el = view.contentEl;
  const nodes = () => Array.from(el.querySelectorAll('.mappy-node'));
  const label = node => node.getAttribute('aria-label') ?? '';
  const nth = (title, index) => nodes().filter(node => label(node) === title)[index];
  const input = () => el.querySelector('textarea.mappy-inline-input');
  const messages = () => [
    ...Array.from(el.querySelectorAll('.mappy-inline-error'), item => item.textContent.trim()),
    ...Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()),
  ].filter(Boolean);
  const source = () => app.vault.read(view.file);`;

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** Click a node until the map shows it selected: the first click after the view opens can land mid-layout. */
const select = async (title, index = 0) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await evaluate(`${VIEW}
      const node = nth(${JSON.stringify(title)}, ${index});
      if (!node) throw new Error('No node ' + ${JSON.stringify(title)} + ' #' + ${index});
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await wait(400);
    const selected = await evaluate(`${VIEW}
      return nth(${JSON.stringify(title)}, ${index})?.classList.contains('is-selected') ?? false;`);
    if (selected) return;
  }
  throw new Error(`The map would not select ${title} #${index}`);
};

const state = () => evaluate(`${VIEW}
  return { messages: messages(), editing: !!input(), labels: nodes().map(label), source: await source() };`);

/** ⌥↑ or ⌥↓ on the selected node: modifiers bit 1 = Alt (scripts/e2e/cdp.mjs). Only sent with no draft open (docs/harness.md 実機検証). */
const moveAlt = async key => {
  const before = await state();
  if (before.editing) throw new Error(`${key} sent while a draft was open`);
  await cdp.realKey(key, 1);
  await wait(800);
  return state();
};

const paste = name => evaluate(`${VIEW}
  const canvas = el.querySelector('.mappy-canvas');
  const file = new File([${PNG}], ${JSON.stringify(name)}, { type: 'image/png' });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
  (document.activeElement ?? canvas).dispatchEvent(event);
  return true;`);

try {
  await step('plugin', async () => {
    if (flag('--reload')) {
      await evaluate(`
        if (document.querySelector('.mappy-inline-input')) throw new Error('A draft is open in this window');
        if (typeof app.plugins.loadManifests === 'function') await app.plugins.loadManifests();
        await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy');
        await new Promise(resolve => setTimeout(resolve, 800));
        return true;`);
    }
    const version = await installedVersion(cdp);
    if (version === null) throw new Error('Mappy is not loaded in this window (restricted mode?). Turn community plugins on and retry.');
    return { version, reloaded: flag('--reload') };
  });

  const opened = await step('open', () => evaluate(`
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
    if (existing) await app.vault.modify(existing, ${JSON.stringify(SOURCE)});
    else await app.vault.create(${JSON.stringify(NOTE)}, ${JSON.stringify(SOURCE)});
    await new Promise(resolve => setTimeout(resolve, 400));
    const opened = app.workspace.getLeaf('tab');
    await opened.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: true });
    await new Promise(resolve => setTimeout(resolve, 1500));
    app.workspace.setActiveLeaf(opened, { focus: true });
    window.__mappyE2E = opened;
    ${VIEW}
    return { labels: nodes().map(label), source: await source() };`));
  const initial = opened.source;

  // 1. ⌥↓ on the first child: the two children swap, and はじめに's own trailing text is untouched.
  const afterDown = await step('move-down', async () => {
    await select('学ぶこと');
    const result = await moveAlt('ArrowDown');
    check(result.messages.length === 0, `⌥↓ showed ${JSON.stringify(result.messages)}`);
    const expected = initial.replace('  - 学ぶこと\n  - 全体の流れ\n', '  - 全体の流れ\n  - 学ぶこと\n');
    check(result.source === expected, `unexpected diff swapping the children:\nbefore: ${JSON.stringify(initial)}\nafter:  ${JSON.stringify(result.source)}`);
    check((result.source.match(new RegExp(TRAILING.replace(/[.]/gu, '\\.'), 'gu')) ?? []).length === 1,
      'the parent\'s trailing text should appear exactly once, unmoved');
    return result;
  });

  // 2. Boundary: 学ぶこと is now the last child of はじめに, with no further sibling there — ⌥↓ must
  // be a no-op, not reach past the trailing text into 記録する.
  await step('move-down-boundary', async () => {
    await select('学ぶこと');
    const result = await moveAlt('ArrowDown');
    check(result.messages.length === 0, `⌥↓ at the boundary showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterDown.source, `⌥↓ past the last child changed the document:\nbefore: ${JSON.stringify(afterDown.source)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // 3. Boundary the other way: 全体の流れ is now the first child — ⌥↑ must be a no-op too (not swap
  // はじめに itself with 記録する at the top level).
  await step('move-up-boundary', async () => {
    await select('全体の流れ');
    const result = await moveAlt('ArrowUp');
    check(result.messages.length === 0, `⌥↑ at the boundary showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterDown.source, `⌥↑ past the first child changed the document:\nbefore: ${JSON.stringify(afterDown.source)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // 4. ⌥↑ back on 学ぶこと: the round trip returns exactly the document this case started from.
  await step('move-up', async () => {
    await select('学ぶこと');
    const result = await moveAlt('ArrowUp');
    check(result.messages.length === 0, `⌥↑ showed ${JSON.stringify(result.messages)}`);
    check(result.source === initial, `the round trip did not return to the original Markdown:\nexpected: ${JSON.stringify(initial)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // 5. An image pasted onto はじめに (the parent, selected but not being edited) lands in its own
  // body, before the child list — the child list and the trailing text must not move.
  await step('attach-image', async () => {
    await select('はじめに');
    await paste('parent-body.png');
    await wait(2000);
    const result = await state();
    check(result.messages.length === 0, `the paste showed ${JSON.stringify(result.messages)}`);
    check(result.labels.filter(title => title === '学ぶこと' || title === '全体の流れ').length === 2,
      'both children of はじめに should still be on the map');
    check(result.source.includes(TRAILING), 'the parent\'s trailing text is missing after the image was attached');
    const imageMatch = result.source.match(/!\[\[parent-body[^\]]*\.png[^\]]*\]\]/u);
    check(!!imageMatch, 'the pasted image was not written into the note');
    if (imageMatch) {
      const firstChildAt = result.source.indexOf('- 学ぶこと');
      const trailingAt = result.source.indexOf(TRAILING);
      check(imageMatch.index < firstChildAt, 'the image should land in the parent\'s own body, before the child list');
      check(imageMatch.index < trailingAt, 'the image should not land after the parent\'s trailing text');
    }
    return result;
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      const attachments = app.vault.getFiles().filter(f => f.extension === 'png' && f.path.includes('parent-body'));
      leaf.detach();
      for (const attachment of attachments) await app.vault.delete(attachment, true);
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      return { removed: [file?.path, ...attachments.map(f => f.path)].filter(Boolean) };`));
  }
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
