import type { ButtonComponent, Setting, TextComponent } from 'obsidian';
import { LicenseRequestError, type Entitlement, type EntitlementState } from '../ai/license/entitlement';
import { t } from '../i18n';
import type { MapSettingDefinition } from './settings-tab';

/** The license line of the AI section, for each state of §11.6. */
export function licenseStatusText(state: EntitlementState): string {
  const text = t();
  switch (state.kind) {
    case 'checking': return text.aiChecking;
    case 'unregistered': return text.aiUnregistered;
    case 'active': return text.aiActive(new Date(state.expiresAt).toLocaleString());
    case 'expired': return text.aiExpired;
    case 'unreachable': return text.aiUnreachable(state.reason);
    case 'invalid': return text.aiInvalid(state.reason);
  }
}

function registerFailure(error: unknown): string {
  const text = t();
  if (error instanceof LicenseRequestError) {
    return error.kind === 'rejected' ? text.aiRegisterRejected(error.reason) : text.aiRegisterUnreachable(error.reason);
  }
  return text.aiRegisterFailed(error instanceof Error ? error.message : String(error));
}

/**
 * The settings tab's「AI」section (docs/architecture.md §11.6, LEV-273): a heading, then the license code, its
 * button and the license's state. Drawing it reads the stored state only; the network is used by the button
 * alone (`register`). LEV-270's rows (engine, paths) join this section, drawn only while the license is `active`.
 *
 * One subscription to the entitlement for the tab's life, and a set of the drawn license rows it brings up to date,
 * as the tab keeps its layout rows: a row leaves the set on its cleanup (1.13+) or when `display()` starts over
 * (`forgetRows`), so a tab opened and closed many times does not pile up listeners.
 */
export class AiSettingsSection {
  /** Each drawn license row's update, by its element. */
  private readonly rows = new Map<() => void, HTMLElement>();

  /** A row out of the document (a search result dropped without its cleanup, the tab hidden) is let go here. */
  constructor(private readonly entitlement: Entitlement) {
    entitlement.onChange(() => {
      for (const [sync, element] of this.rows) {
        if (element.isConnected) sync();
        else this.rows.delete(sync);
      }
    });
  }

  definitions(): MapSettingDefinition[] {
    const text = t();
    return [
      {
        name: text.setAi,
        desc: MAPPY_AI_DEV_UNLOCK ? text.setAiDevUnlock : text.setAiDesc,
        render: setting => { setting.setHeading(); },
      },
      {
        name: text.setAiLicense,
        desc: '',
        render: setting => this.renderLicenseRow(setting),
      },
    ];
  }

  /** `display()` draws every row again: the previous ones are let go. */
  forgetRows(): void {
    this.rows.clear();
  }

  /** The code field, the button and the state line. A failed registration leaves the state as it was and says why under it. */
  private renderLicenseRow(setting: Setting): () => void {
    const { entitlement } = this;
    const status = setting.descEl.createDiv({ cls: 'mappy-setting-ai-status' });
    const failure = setting.descEl.createDiv({ cls: 'mappy-setting-ai-failure' });
    failure.hidden = true;
    let code = '';
    let busy = false;
    let input: TextComponent | null = null;
    let button: ButtonComponent | null = null;
    const sync = (): void => {
      status.setText(MAPPY_AI_DEV_UNLOCK ? t().setAiDevUnlock : licenseStatusText(entitlement.state()));
      button?.setDisabled(busy || code.trim() === '');
      input?.setDisabled(busy);
    };
    const submit = async (): Promise<void> => {
      if (busy || code.trim() === '') return;
      busy = true;
      failure.hidden = true;
      sync();
      try {
        await entitlement.register(code);
        code = '';
        input?.setValue('');
      } catch (error) {
        failure.setText(registerFailure(error));
        failure.hidden = false;
      } finally {
        busy = false;
        sync();
      }
    };
    setting.addText(field => {
      input = field;
      field.setPlaceholder(t().setAiLicensePlaceholder).onChange(value => { code = value; sync(); });
    });
    setting.addButton(control => {
      button = control;
      control.setButtonText(t().setAiRegister).setCta().onClick(() => { void submit(); });
    });
    this.rows.set(sync, setting.settingEl);
    sync();
    return () => { this.rows.delete(sync); };
  }
}
