import { setLanguage } from '../src/i18n';

// Every test file starts in Japanese, the language the expected text in tests/ is written in; the plugin sets it
// from Obsidian's in onload, which no test runs. tests/i18n covers the choice itself and the English table.
setLanguage('ja');
