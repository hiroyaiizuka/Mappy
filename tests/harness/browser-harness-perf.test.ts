import { describe, expect, it } from 'vitest';
import {
  LAYOUTS, buildSummary, highlights, recordMarkdown, selectFixtures, selectLayouts, type PerfEnvironment,
} from '../../scripts/browser-harness-perf.mjs';
import { LAYOUT_MODES } from '../../src/core/layout-mode';

const env: PerfEnvironment = {
  at: '2026-09-18T00:00:00.000Z', os: 'macOS 26.5.1 (25F80)', arch: 'arm64', cpu: 'Apple M4 Max', cores: 16, memoryGb: 128, loadavg: [1.5, 2, 2.5],
  node: 'v22.22.3', chrome: 'Google Chrome 153', chromePath: '/Applications/Google Chrome.app', chromeFlags: '--headless=new', gpu: false,
  window: { width: 1640, height: 1000 }, pane: { width: 1280, height: 800 }, commit: 'abc1234', dirty: false,
  options: { repeat: 10, keystrokes: 30, frames: 60, layouts: ['mindmap', 'hierarchy'] },
};

function load(fixture: string, firstLayoutMs: number, mode = 'mindmap'): Record<string, unknown> {
  return { kind: 'load', fixture, mode, nodes: 500, parseMs: 1, stateMs: 5, measureMs: 5, layoutMs: 0.3, frameMs: 12, paintMs: 3, firstLayoutMs, settledMs: 90, frames: 1 };
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

  it('measures the product\'s three layouts by default, in the product\'s order, and rejects unknown ones', () => {
    expect(LAYOUTS).toEqual([...LAYOUT_MODES]);
    expect(selectLayouts({})).toEqual(['mindmap', 'timeline', 'hierarchy']);
    expect(selectLayouts({ layouts: ['hierarchy', 'mindmap'] })).toEqual(['mindmap', 'hierarchy']);
    expect(() => selectLayouts({ layouts: ['radial'] })).toThrow(/Unknown layout/u);
  });

  it('summarises p50/p95 per fixture, layout and kind, counting frames over budget', () => {
    const fixtures = selectFixtures({ fixtures: ['performance-500'] });
    const samples = [
      ...[20, 22, 24, 26, 28, 30, 32, 34, 36, 100].map(value => load('performance-500', value)),
      load('performance-500', 70, 'hierarchy'),
      { kind: 'markdown-edit', fixture: 'performance-500', mode: 'mindmap', nodes: 500, debounceMs: 46, parseMs: 1, refreshMs: 3, waitMs: 2, frameMs: 2, paintMs: 10, totalMs: 64, settledMs: 150 },
      { kind: 'pan', fixture: 'performance-500', mode: 'mindmap', nodes: 500, intervals: [16.7, 16.7, 33.4, 16.6] },
      { kind: 'load', fixture: 'performance-2000', mode: 'mindmap', nodes: 2000, firstLayoutMs: 999 },
    ];
    const summary = buildSummary(fixtures, samples);
    expect(summary.map(row => [row.fixture, row.layout])).toEqual([
      ['performance-500', 'mindmap'], ['performance-500', 'timeline'], ['performance-500', 'hierarchy'],
    ]);
    const [mindmap, timeline, hierarchy] = summary;
    expect(mindmap?.load.firstLayoutMs).toMatchObject({ n: 10, p50: 28, p95: 100, min: 20, max: 100 });
    expect(mindmap?.['markdown-edit'].totalMs).toMatchObject({ n: 1, p50: 64, p95: 64 });
    expect(mindmap?.pan).toMatchObject({ n: 4, over: 1, max: 33.4 });
    expect(mindmap?.zoom.n).toBe(0);
    expect(mindmap?.['inline-key'].totalMs?.n).toBe(0);
    expect(timeline?.load.firstLayoutMs?.n).toBe(0);
    expect(hierarchy?.load.firstLayoutMs).toMatchObject({ n: 1, p50: 70 });
    // A record from before the layout dimension has no `mode`; it belongs to the mind map.
    expect(buildSummary(fixtures, [{ ...load('performance-500', 5), mode: undefined }], ['mindmap'])[0]?.load.firstLayoutMs?.n).toBe(1);
  });

  it('reads the worst p95 across shapes per layout for the §6 targets', () => {
    const fixtures = selectFixtures({ counts: [500, 2000], shapes: ['headings', 'wide'] });
    const edit = (fixture: string, mode: string, totalMs: number): Record<string, unknown> =>
      ({ kind: 'markdown-edit', fixture, mode, nodes: 500, debounceMs: 46, parseMs: 1, refreshMs: 3, waitMs: 2, frameMs: 2, paintMs: 10, totalMs, settledMs: 150 });
    const samples = [
      edit('performance-500', 'mindmap', 60), edit('performance-500-wide', 'mindmap', 80), edit('performance-500', 'hierarchy', 70),
      load('performance-2000', 300, 'mindmap'), load('performance-2000-wide', 400, 'mindmap'),
      { kind: 'pan', fixture: 'performance-2000', mode: 'mindmap', nodes: 2000, intervals: [16.7, 40] },
      { kind: 'pan', fixture: 'performance-2000-wide', mode: 'mindmap', nodes: 2000, intervals: [16.7, 16.7, 16.7] },
    ];
    const [mindmap, timeline, hierarchy] = highlights(buildSummary(fixtures, samples));
    expect(mindmap).toMatchObject({ layout: 'mindmap', markdownEdit500: 80, firstLayout2000: 400, settled2000: 90, pan2000: { over: 1, n: 5 }, zoom2000: { over: 0, n: 0 } });
    expect(Number.isNaN(mindmap?.inlineKey500)).toBe(true);
    expect(hierarchy?.markdownEdit500).toBe(70);
    expect(Number.isNaN(timeline?.markdownEdit500)).toBe(true);
  });

  it('writes the machine, the stage definitions, one row per fixture and layout, and the not-executed list into the record', () => {
    const fixtures = selectFixtures({ fixtures: ['performance-500', 'performance-500-japanese'] });
    const layouts = ['mindmap', 'hierarchy'];
    const summary = buildSummary(fixtures, [load('performance-500', 24), load('performance-500', 30, 'hierarchy')], layouts);
    const record = recordMarkdown({ env, fixtures, summary, notExecuted: ['Obsidian 実機での計測（E10）'], failures: ['performance-500 hierarchy pan 1: boom'] });
    expect(record).toContain('Apple M4 Max（16 コア、128 GB）、macOS 26.5.1 (25F80)、arm64。開始時の load average 1.5 / 2 / 2.5');
    expect(record).toContain('Node: v22.22.3、Chrome: Google Chrome 153');
    expect(record).toContain('build: abc1234（');
    expect(record).toContain('レイアウト（マップ・階層図）ごとに読み込み 10 回');
    expect(record).toContain('## 要点');
    expect(record).toContain('| マップ | — | — | — | — | — | — | — | — |');
    expect(record).toContain('## 段階の定義');
    expect(record).toContain('| performance-500 | 見出し形式 | 500 | マップ | 1 | 1.0 / 1.0 | 5.0 / 5.0 |');
    expect(record).toContain('| performance-500 | 見出し形式 | 500 | 階層図 | 1 | 1.0 / 1.0 | 5.0 / 5.0 |');
    expect(record).not.toContain('| performance-500 | 見出し形式 | 500 | タイムライン |');
    expect(record).toContain('| performance-500-japanese | 長い日本語 | 500 | マップ | 0 | — / — |');
    expect(record).toContain('- Obsidian 実機での計測（E10）');
    expect(record).toContain('- performance-500 hierarchy pan 1: boom');
    expect(record).toContain('レイアウト: mindmap, hierarchy');
    expect(recordMarkdown({ env: { ...env, dirty: true }, fixtures, summary, notExecuted: [], failures: [] })).toContain('（未コミットの変更あり）');
  });
});
