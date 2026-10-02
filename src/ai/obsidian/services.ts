import type { TFile } from 'obsidian';
import type { AiMaterial } from '../contract';
import type { Entitlement } from '../license/entitlement';
import type { RunnerFactory } from '../runner-factory';
import type { AiPrefsStore } from '../settings';
import { AiAttachmentError, type AiServices } from '../../ui/ai/services';
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
  return {
    // The view shows the AI for an active license. Where nothing could run (Windows, no Node) that would open an input
    // whose run is refused for no reason it could name: the view is told it is not available instead.
    state: () => {
      const state = entitlement.state();
      if (state.kind !== 'active') return state;
      const availability = factory.availability();
      return availability === 'available' ? state : { kind: 'invalid', reason: availability };
    },
    onChange: listener => entitlement.onChange(() => { listener(); }),
    refresh: () => entitlement.refresh(),
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
