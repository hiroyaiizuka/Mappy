// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Entitlement } from '../../../src/ai/license/entitlement';
import { AiSettingsSection } from '../../../src/obsidian/ai-settings';

vi.mock('obsidian', () => import('../../browser-harness/obsidian'));

/** The settings' AI section (LEV-273) with LEV-270's rows after the license row (§11.8 wiring). */
describe('AiSettingsSection with the runner rows', () => {
  const entitlement = { state: () => ({ kind: 'unregistered' }), onChange: () => () => undefined } as unknown as Entitlement;

  it('puts the runner rows after the heading and the license row, asking for them each time it is drawn', () => {
    const rows = vi.fn(() => [{ name: 'AI のエンジン', desc: '', render: () => undefined }]);
    const section = new AiSettingsSection(entitlement, rows);
    expect(section.definitions().map(definition => definition.name)).toEqual(['AI 機能', 'ライセンスコード', 'AI のエンジン']);
    section.definitions();
    expect(rows).toHaveBeenCalledTimes(2);
  });

  it('has no runner rows when none are given (the license section alone)', () => {
    expect(new AiSettingsSection(entitlement).definitions().map(definition => definition.name)).toEqual(['AI 機能', 'ライセンスコード']);
  });
});
