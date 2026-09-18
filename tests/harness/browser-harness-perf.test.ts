import { describe, expect, it } from 'vitest';
import { buildSummary, recordMarkdown, selectFixtures, type PerfEnvironment } from '../../scripts/browser-harness-perf.mjs';

const env: PerfEnvironment = {
  at: '2026-09-18T00:00:00.000Z', os: 'macOS 26.5.1 (25F80)', arch: 'arm64', cpu: 'Apple M4 Max', cores: 16, memoryGb: 128, loadavg: [1.5, 2, 2.5],
  node: 'v22.22.3', chrome: 'Google Chrome 153', chromePath: '/Applications/Google Chrome.app', chromeFlags: '--headless=new', gpu: false,
  window: { width: 1640, height: 1000 }, pane: { width: 1280, height: 800 }, commit: 'abc1234', dirty: false,
  options: { repeat: 10, keystrokes: 30, frames: 60 },
};

function load(fixture: string, firstLayoutMs: number): Record<string, unknown> {
  return { kind: 'load', fixture, nodes: 500, parseMs: 1, stateMs: 5, measureMs: 5, layoutMs: 0.3, frameMs: 12, paintMs: 3, firstLayoutMs, settledMs: 90, frames: 1 };
}

describe('browser-harness-perf', () => {
  it('selects fixtures by shape, count or id and rejects unknown shapes', () => {
    expect(selectFixtures({}).map(entry => entry.id)).toHaveLength(24);
    expect(selectFixtures({ shapes: ['headings'] }).map(entry => entry.id))
      .toEqual(['performance-10', 'performance-100', 'performance-500', 'performance-2000']);
    expect(selectFixtures({ counts: [500], shapes: ['deep', 'wide'] }).map(entry => entry.id))
      .toEqual(['performance-500-deep', 'performance-500-wide']);
    expect(selectFixtures({ fixtures: ['performance-2000-links'] }).map(entry => entry.id)).toEqual(['performance-2000-links']);
    expect(() => selectFixtures({ shapes: ['spiral'] })).toThrow(/Unknown shape/u);
  });

  it('summarises p50/p95 per fixture and kind, counting frames over budget', () => {
    const fixtures = selectFixtures({ fixtures: ['performance-500'] });
    const samples = [
      ...[20, 22, 24, 26, 28, 30, 32, 34, 36, 100].map(value => load('performance-500', value)),
      { kind: 'markdown-edit', fixture: 'performance-500', nodes: 500, debounceMs: 46, parseMs: 1, refreshMs: 3, waitMs: 2, frameMs: 2, paintMs: 10, totalMs: 64, settledMs: 150 },
      { kind: 'pan', fixture: 'performance-500', nodes: 500, intervals: [16.7, 16.7, 33.4, 16.6] },
      { kind: 'load', fixture: 'performance-2000', nodes: 2000, firstLayoutMs: 999 },
    ];
    const [summary] = buildSummary(fixtures, samples);
    expect(summary?.fixture).toBe('performance-500');
    expect(summary?.load.firstLayoutMs).toMatchObject({ n: 10, p50: 28, p95: 100, min: 20, max: 100 });
    expect(summary?.['markdown-edit'].totalMs).toMatchObject({ n: 1, p50: 64, p95: 64 });
    expect(summary?.pan).toMatchObject({ n: 4, over: 1, max: 33.4 });
    expect(summary?.zoom.n).toBe(0);
    expect(summary?.['inline-key'].totalMs?.n).toBe(0);
  });

  it('writes the machine, the stage definitions, one row per fixture and the not-executed list into the record', () => {
    const fixtures = selectFixtures({ fixtures: ['performance-500', 'performance-500-japanese'] });
    const summary = buildSummary(fixtures, [load('performance-500', 24)]);
    const record = recordMarkdown({ env, fixtures, summary, notExecuted: ['Obsidian 実機での計測（E10）'], failures: ['performance-500 pan 1: boom'] });
    expect(record).toContain('Apple M4 Max（16 コア、128 GB）、macOS 26.5.1 (25F80)、arm64。開始時の load average 1.5 / 2 / 2.5');
    expect(record).toContain('Node: v22.22.3、Chrome: Google Chrome 153');
    expect(record).toContain('build: abc1234（');
    expect(record).toContain('## 段階の定義');
    expect(record).toContain('| performance-500 | 見出し形式 | 500 | 1 | 1.0 / 1.0 | 5.0 / 5.0 |');
    expect(record).toContain('| performance-500-japanese | 長い日本語 | 500 | 0 | — / — |');
    expect(record).toContain('- Obsidian 実機での計測（E10）');
    expect(record).toContain('- performance-500 pan 1: boom');
    expect(recordMarkdown({ env: { ...env, dirty: true }, fixtures, summary, notExecuted: [], failures: [] })).toContain('（未コミットの変更あり）');
  });
});
