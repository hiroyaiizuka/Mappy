import type { TFile } from 'obsidian';
import type { AiMaterial } from '../contract';
import type { Entitlement } from '../license/entitlement';
import type { RunnerFactory } from '../runner-factory';
import type { AiPrefsStore } from '../settings';
import { AiAttachmentError, type AiEntitlementView, type AiServices } from '../../ui/ai/services';
import { FakeRunner } from '../../ui/ai/fake-runner';
import type { VaultMaterials } from './material';

/**
 * What the map's AI (LEV-271) gets from the plugin (docs/architecture.md §11.8, wired by the third of the three to
 * merge): the license (LEV-273), the runner factory (LEV-270) and the attachments read through LEV-270's materials.
 * The view sees only these; the runner is made per run, so a license that lapsed makes no runner (and a runner made
 * before the lapse refuses to start, `not-entitled`).
 */
export function createAiServices(options: {
  entitlement: Entitlement;
  factory: RunnerFactory;
  prefs: AiPrefsStore;
  vault: VaultMaterials;
}): AiServices {
  const { entitlement, factory, prefs, vault } = options;
  /**
   * The license as the view should take it on this app. The view shows the AI for `active`, `expired` and
   * `unreachable`; where nothing could run that would open an input whose run is refused. So on Windows or outside the
   * desktop app (known without Node) every one of them reads `invalid` with `unsupported-platform`, and an active
   * license where Node is not to be had (known once Node is asked for, which only `active` allows) reads `no-node`.
   * A refresh goes through the same, so the button never opens the input there.
   */
  const onThisApp = (state: AiEntitlementView): AiEntitlementView => {
    const shown = state.kind === 'active' || state.kind === 'expired' || state.kind === 'unreachable';
    if (!shown) return state;
    if (!factory.platformSupported()) return { kind: 'invalid', reason: 'unsupported-platform' };
    if (state.kind === 'active' && factory.availability() === 'no-node') return { kind: 'invalid', reason: 'no-node' };
    return state;
  };
  return {
    state: () => onThisApp(entitlement.state()),
    onChange: listener => entitlement.onChange(() => { listener(); }),
    refresh: async () => onThisApp(await entitlement.refresh()),
    createRunner: () => factory.create(),
    defaultEngine: () => prefs.current().engine,
    readAttachment: async (file: TFile, signal: AbortSignal): Promise<AiMaterial> => {
      const pdf = file.extension.toLowerCase() === 'pdf';
      const read = pdf ? await vault.pdf(file.path, signal) : await vault.note(file.path);
      if (read.kind === 'ok') return { kind: pdf ? 'pdf' : 'note', label: file.path, text: read.text };
      if (read.kind === 'cancelled') throw new AiAttachmentError('material-failed', 'cancelled');
      throw new AiAttachmentError(read.reason, read.detail);
    },
    // Only a development-unlock build offers the engine without a CLI (the E2E on the test vault). In a release build
    // the constant is false and esbuild drops the class.
    ...(MAPPY_AI_DEV_UNLOCK ? { fakeRunner: new FakeRunner() } : {}),
  };
}
