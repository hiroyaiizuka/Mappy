import { describe, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import type { AiRunner } from '../../../src/ai/contract';
import type { Entitlement } from '../../../src/ai/license/entitlement';
import type { VaultMaterials } from '../../../src/ai/obsidian/material';
import { createAiServices } from '../../../src/ai/obsidian/services';
import type { RunnerFactory } from '../../../src/ai/runner-factory';
import { DEFAULT_AI_PREFS } from '../../../src/ai/settings';
import { AiAttachmentError } from '../../../src/ui/ai/services';

/** The AI's services as main.ts wires them (docs/architecture.md §11.8): the license, the runner, the attachments. */

function services(vault: Partial<VaultMaterials> = {}, created: AiRunner | null = null, availability = 'available') {
  const entitlement = { state: () => ({ kind: 'active', expiresAt: 0 }), onChange: vi.fn(() => () => undefined), refresh: vi.fn() } as unknown as Entitlement;
  const create = vi.fn(() => created);
  const factory = { create, availability: () => availability } as unknown as RunnerFactory;
  const materials: VaultMaterials = {
    pdf: vault.pdf ?? (() => Promise.resolve({ kind: 'ok' as const, text: 'pdf text' })),
    note: vault.note ?? (() => Promise.resolve({ kind: 'ok' as const, text: 'note text' })),
  };
  return { made: createAiServices({ entitlement, factory, prefs: { current: () => ({ ...DEFAULT_AI_PREFS, engine: 'codex' }), save: () => Promise.resolve() }, vault: materials }), create };
}

const file = (path: string, extension: string) => ({ path, extension } as unknown as TFile);

describe('createAiServices', () => {
  it('reads a PDF and a note as materials, labelled with their path', async () => {
    const { made } = services();
    const signal = new AbortController().signal;
    await expect(made.readAttachment(file('docs/a.PDF', 'PDF'), signal)).resolves.toEqual({ kind: 'pdf', label: 'docs/a.PDF', text: 'pdf text' });
    await expect(made.readAttachment(file('notes/n.md', 'md'), signal)).resolves.toEqual({ kind: 'note', label: 'notes/n.md', text: 'note text' });
  });

  it('rejects with the failure the card names', async () => {
    const { made } = services({ pdf: () => Promise.resolve({ kind: 'failed' as const, reason: 'no-pdf-text' as const, detail: 'scan.pdf' }) });
    const rejected = made.readAttachment(file('scan.pdf', 'pdf'), new AbortController().signal);
    await expect(rejected).rejects.toBeInstanceOf(AiAttachmentError);
    await expect(rejected).rejects.toMatchObject({ reason: 'no-pdf-text', message: 'scan.pdf' });
  });

  it('asks the factory for each runner and the settings for the engine', () => {
    const { made, create } = services();
    expect(made.createRunner()).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(made.defaultEngine()).toBe('codex');
  });

  it('shows no AI where an active license cannot run anything (Windows, no Node)', () => {
    expect(services().made.state()).toEqual({ kind: 'active', expiresAt: 0 });
    expect(services({}, null, 'unsupported-platform').made.state()).toEqual({ kind: 'invalid', reason: 'unsupported-platform' });
    expect(services({}, null, 'no-node').made.state()).toEqual({ kind: 'invalid', reason: 'no-node' });
  });

  it('offers no fake engine outside a development-unlock build', () => {
    expect(services().made.fakeRunner).toBeUndefined();
  });
});
