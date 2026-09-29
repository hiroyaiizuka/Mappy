/**
 * Switching the test Obsidian's language, for the cases that run in more than one (E63 english-ui.mjs, E69
 * main-topic.mjs, E71 central-topic.mjs). Every other case refuses a window in a language other than `MAPPY_E2E_LANGUAGE` (cdp.mjs `connect`).
 */
import { connect, wait } from './cdp.mjs';

/**
 * The app in `language`, as Settings → General → Language leaves it: the stored key (`null` removes it), then the app
 * reloaded (`getLanguage()` is read at start). `cdp` is closed; the connection the window answered on in `expected`,
 * with Mappy loaded, is returned and the others are closed. When the window never comes back that way it throws.
 */
export async function switchLanguage(cdp, language, expected = language) {
  const key = language === null ? "localStorage.removeItem('language')" : `localStorage.setItem('language', ${JSON.stringify(language)})`;
  await cdp.evaluate(`(async () => { ${key}; setTimeout(() => app.commands.executeCommandById('app:reload'), 50); return true; })()`);
  cdp.close();
  await wait(3000);
  let refused = null;
  for (const started = Date.now(); Date.now() - started < 30000; await wait(1000)) {
    let next = null;
    try {
      next = await connect({ language: expected });
      // `plugins.mappy` exists before its async onload is through; the last command it registers says it is.
      if (await next.evaluate("!!(app.workspace.layoutReady && app.plugins.plugins.mappy && app.commands.commands['mappy:convert-to-list'])")) return next;
      refused = new Error('Mappy is not loaded yet');
    } catch (error) { refused = error; }
    next?.close();
  }
  throw refused ?? new Error(`the window did not come back in ${expected} with Mappy loaded within 30 s`);
}
