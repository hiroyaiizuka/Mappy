/**
 * E37 (docs/harness.md): paste an image onto a node, twice, on the real Obsidian.
 *
 * The steps are the ones the user actually performs, because that is what broke twice: an image pasted
 * onto a node leaves that node with no title, so the next paste happens on a map that already holds an
 * untitled node. Matched by title, every untitled node is the same node, and the ids used to be reassigned
 * on each write — the draft then lost its node and the map answered
 * 「編集していたノードが Markdown 側で見つかりません。マップでノードを選び直してください。」 (LEV-146; the same
 * failure for repeated titles was LEV-142). `tests/ui/mindmap-view-paste.test.ts` holds this matrix in
 * jsdom; this case runs it through the real write path, watcher and renderer.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:paste -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --reload  re-enable the plugin first, so a build made after Obsidian started is the one under test
 *   --keep    leave the note and its attachments in the vault
 */
import { writeFile } from 'node:fs/promises';
import { connect, installedVersion, VAULT, wait } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };

const NOTE = 'Fixtures/E2E-paste-image.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 画像を貼る', '',
  '- はじめに', '  - 学ぶこと',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');
/** A one-pixel PNG, written as bytes so nothing has to reach the OS clipboard. */
const PNG = 'new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,10,73,68,65,84,120,156,99,0,1,0,0,5,0,1,13,10,45,180,0,0,0,0,73,69,78,68,174,66,96,130])';

/** Read out of the view under test: its nodes, its inline editor and every message on screen. */
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

const record = { vault: VAULT, note: NOTE, steps: {}, failures: [] };
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = async (name, run) => {
  try { record.steps[name] = await run(); } catch (error) { record.steps[name] = { error: String(error) }; record.failures.push(`${name}: ${error}`); }
  console.log(name, JSON.stringify(record.steps[name]).slice(0, 700));
  return record.steps[name];
};
const check = (condition, failure) => { if (!condition) record.failures.push(failure); };

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

/** Tab: a new child, named in place. Answered by the inline editor being open on an empty node. */
const addChild = async () => {
  await cdp.realKey('Tab');
  await wait(1200);
  const editing = await evaluate(`${VIEW} return !!input();`);
  if (!editing) throw new Error('Tab did not open the inline editor on a new child');
};
/** The clipboard as Obsidian delivers an image: a paste event carrying a file. The OS clipboard cannot be driven from CDP; everything past this event is the shipped code. */
const paste = name => evaluate(`${VIEW}
  const canvas = el.querySelector('.mappy-canvas');
  const file = new File([${PNG}], ${JSON.stringify(name)}, { type: 'image/png' });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
  (document.activeElement ?? canvas).dispatchEvent(event);
  return true;`);
const state = () => evaluate(`${VIEW}
  return { messages: messages(), editing: !!input(), labels: nodes().map(label), source: await source() };`);

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
    if (version === null) {
      // A vault opened for the first time starts in restricted mode, and then the plugin is enabled in the
      // settings but never loaded: `app.plugins.setEnable(true)` in the window turns community plugins on.
      throw new Error('Mappy is not loaded in this window (restricted mode?). Turn community plugins on and retry.');
    }
    return { version, reloaded: flag('--reload') };
  });

  await step('open', () => evaluate(`
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
    return { labels: nodes().map(label) };`));

  // 1. A new node, an image pasted onto it, and the node left as the user leaves it: untitled.
  await step('first-paste', async () => {
    await select('記録する');
    await addChild();
    await paste('first.png');
    await wait(2500);
    const after = await state();
    await cdp.realKey('Escape');
    await wait(600);
    const settled = await state();
    check(after.messages.length === 0, `first paste showed ${JSON.stringify(after.messages)}`);
    check(settled.source.includes('first.png'), 'the first image was not written into the note');
    check(settled.labels.includes('空のノード'), 'the node that took the image should still be untitled');
    return { after, settled };
  });

  // 2. The same again, with that untitled node still on the map: the shape that failed on 0.3.1 and 0.3.2.
  await step('second-paste', async () => {
    await select('はじめに');
    await addChild();
    await paste('second.png');
    await wait(2500);
    const afterPaste = await state();
    await cdp.insertText('二枚目の話');
    await wait(300);
    await cdp.realKey('Enter');
    await wait(2000);
    const afterEnter = await state();
    check(afterPaste.messages.length === 0, `second paste showed ${JSON.stringify(afterPaste.messages)}`);
    check(afterEnter.messages.length === 0, `confirming the title showed ${JSON.stringify(afterEnter.messages)}`);
    check(!afterEnter.editing, 'the inline editor should have closed on Enter');
    check(afterEnter.source.includes('- 二枚目の話'), 'the title was not written into the note');
    check(afterEnter.source.includes('second.png'), 'the second image was not written into the note');
    check(afterEnter.labels.includes('二枚目の話'), 'the map does not show the named node');
    return { afterPaste, afterEnter };
  });

  const shot = value('--shot');
  if (shot) await step('shot', () => cdp.screenshot(shot));

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const attachments = app.vault.getFiles().filter(file => /(first|second)\\.png$/u.test(file.path));
      for (const file of [...attachments, view.file]) await app.vault.delete(file, true);
      leaf.detach();
      delete window.__mappyE2E;
      return { removed: attachments.map(file => file.path) };`));
  }
} finally {
  cdp.close();
}

record.passed = record.failures.length === 0;
const out = value('--json');
if (out) await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(record.passed ? 'PASS' : `FAIL\n- ${record.failures.join('\n- ')}`);
process.exit(record.passed ? 0 : 1);
