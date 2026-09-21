import type { PerformanceFixtureEntry } from './performance-fixtures.mjs';
import type { Summary } from './perf-stats.mjs';

export const LAYOUTS: readonly string[];
export interface PerfOptions { shapes?: string[]; counts?: number[]; fixtures?: string[]; layouts?: string[] }
export function selectFixtures(options: PerfOptions): PerformanceFixtureEntry[];
export function selectLayouts(options: PerfOptions): string[];
export interface FixtureSummary {
  fixture: string;
  nodes: number;
  shape: string;
  layout: string;
  load: Record<string, Summary>;
  'markdown-edit': Record<string, Summary>;
  'inline-key': Record<string, Summary>;
  'inline-commit': Record<string, Summary>;
  pan: Summary & { over: number; handler: Summary };
  zoom: Summary & { over: number; handler: Summary };
  'topic-drag': Summary & { over: number; handler: Summary; frame: Summary; moves: number; snapMoves: number; slots: number };
}
export function buildSummary(fixtures: PerformanceFixtureEntry[], samples: Record<string, unknown>[], layouts?: string[]): FixtureSummary[];
export interface Highlight {
  layout: string;
  markdownEdit500: number; inlineKey500: number; inlineCommit500: number;
  markdownEdit2000: number; firstLayout2000: number; settled2000: number;
  pan2000: { over: number; n: number }; zoom2000: { over: number; n: number };
  dragHandler2000: number; dragFrame2000: number;
}
export function highlights(summary: FixtureSummary[], layouts?: string[]): Highlight[];
export interface PerfEnvironment {
  at: string; os: string; arch: string; cpu: string; cores: number; memoryGb: number; loadavg: number[]; node: string; chrome: string;
  chromePath: string | null; chromeFlags: string; gpu: boolean; window: { width: number; height: number }; pane: { width: number; height: number };
  commit: string; dirty: boolean; options: { repeat: number; keystrokes: number; frames: number; layouts?: string[] };
}
export function recordMarkdown(input: {
  env: PerfEnvironment; fixtures: PerformanceFixtureEntry[]; summary: FixtureSummary[]; notExecuted: string[]; failures: string[];
}): string;
