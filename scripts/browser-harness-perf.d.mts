import type { PerformanceFixtureEntry } from './performance-fixtures.mjs';
import type { Summary } from './perf-stats.mjs';

export interface PerfOptions { shapes?: string[]; counts?: number[]; fixtures?: string[] }
export function selectFixtures(options: PerfOptions): PerformanceFixtureEntry[];
export interface FixtureSummary {
  fixture: string;
  nodes: number;
  shape: string;
  load: Record<string, Summary>;
  'markdown-edit': Record<string, Summary>;
  'inline-key': Record<string, Summary>;
  'inline-commit': Record<string, Summary>;
  pan: Summary & { over: number };
  zoom: Summary & { over: number };
}
export function buildSummary(fixtures: PerformanceFixtureEntry[], samples: Record<string, unknown>[]): FixtureSummary[];
export interface PerfEnvironment {
  at: string; os: string; arch: string; cpu: string; cores: number; memoryGb: number; loadavg: number[]; node: string; chrome: string;
  chromePath: string | null; chromeFlags: string; window: { width: number; height: number }; pane: { width: number; height: number };
  commit: string; dirty: boolean; options: { repeat: number; keystrokes: number; frames: number };
}
export function recordMarkdown(input: {
  env: PerfEnvironment; fixtures: PerformanceFixtureEntry[]; summary: FixtureSummary[]; notExecuted: string[]; failures: string[];
}): string;
