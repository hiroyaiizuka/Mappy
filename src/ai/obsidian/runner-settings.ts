import { Notice, Setting } from 'obsidian';
import { t } from '../../i18n';
import { INSTALL_URLS, type Tool } from '../core/launch';
import { findWithLoginShell, locate } from '../host/locate';
import type { RunnerFactory } from '../runner-factory';
import type { AiPrefs, AiPrefsStore, RunnerPathsStore } from '../settings';

/**
 * The runner's rows in the settings tab's AI section (docs/architecture.md §11.3, §11.8): the engine, each engine's
 * model, and where claude, codex and yt-dlp are, with 「探す」. LEV-273's section calls this. Nothing is drawn, and
 * nothing is looked for, unless the license is active: the factory hands out its Node surface only then (§11.7).
 */

const TOOLS: readonly Tool[] = ['claude', 'codex', 'yt-dlp'];

export interface RunnerSettingsDeps {
  factory: RunnerFactory;
  prefs: AiPrefsStore;
  paths: RunnerPathsStore;
}

export function renderRunnerSettings(containerEl: HTMLElement, deps: RunnerSettingsDeps): void {
  const text = t();
  const availability = deps.factory.availability();
  if (availability === 'not-entitled') return;
  if (availability === 'unsupported-platform' || availability === 'no-node') {
    new Setting(containerEl).setName(text.aiEngine).setDesc(availability === 'no-node' ? text.aiNoNode : text.aiUnsupported);
    return;
  }
  const host = deps.factory.host();
  if (host === null) return;

  const savePrefs = (change: Partial<AiPrefs>): void => {
    deps.prefs.save({ ...deps.prefs.current(), ...change }).catch(() => { new Notice(text.setSaveFailed); });
  };
  new Setting(containerEl).setName(text.aiEngine).setDesc(text.aiEngineDesc).addDropdown(dropdown => {
    dropdown.addOptions({ claude: text.aiEngineClaude, codex: text.aiEngineCodex })
      .setValue(deps.prefs.current().engine)
      .onChange(value => { savePrefs({ engine: value === 'codex' ? 'codex' : 'claude' }); });
  });
  for (const [engine, key] of [['claude', 'claudeModel'], ['codex', 'codexModel']] as const) {
    new Setting(containerEl).setName(text.aiModel(engine)).setDesc(text.aiModelDesc).addText(input => {
      input.setValue(deps.prefs.current()[key]).onChange(value => { savePrefs({ [key]: value.trim() }); });
    });
  }

  for (const tool of TOOLS) {
    const setting = new Setting(containerEl).setName(text.aiPath(tool));
    // What the empty field stands for: the first known place that has the tool (files are only checked, nothing runs).
    // Each edit asks again; only the latest answer is shown (an earlier check can finish after a later one).
    let asked = 0;
    const describe = async (): Promise<void> => {
      const ask = ++asked;
      const configured = deps.paths.current()[tool];
      const desc = configured
        ? (await host.isExecutable(configured) ? '' : text.aiPathInvalid)
        : await locate(host, tool).then(found => found === null ? text.aiPathMissing(INSTALL_URLS[tool]) : text.aiPathFound(found));
      if (ask === asked) setting.setDesc(desc);
    };
    const save = (value: string): void => {
      deps.paths.save({ ...deps.paths.current(), [tool]: value.trim() });
      void describe();
    };
    let field: { setValue(value: string): unknown } | null = null;
    setting.addText(input => {
      field = input;
      input.setPlaceholder('/…/' + tool).setValue(deps.paths.current()[tool]).onChange(save);
    });
    setting.addButton(button => {
      button.setButtonText(text.aiFind).setTooltip(text.aiFindDesc).onClick(async () => {
        button.setDisabled(true);
        try {
          const found = await findWithLoginShell(host, tool, new AbortController().signal);
          if (found === null) { new Notice(text.aiFindNotFound(tool)); return; }
          field?.setValue(found);
          save(found);
        } finally {
          button.setDisabled(false);
        }
      });
    });
    void describe();
  }
}
