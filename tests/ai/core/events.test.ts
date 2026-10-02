import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AiProgress } from '../../../src/ai/contract';
import { claudeReader, codexReader, type StreamReader } from '../../../src/ai/core/events';

/** A fixture's lines through a reader: the progress with repeats folded, and the outcome. */
function replay(name: string, reader: StreamReader): { progress: AiProgress[]; outcome: ReturnType<StreamReader['outcome']> } {
  const progress: AiProgress[] = [];
  for (const line of readFileSync(new URL(`../../fixtures/ai/${name}`, import.meta.url), 'utf8').split('\n')) {
    for (const step of reader.line(line)) {
      const last = progress[progress.length - 1];
      if (!last || JSON.stringify(last) !== JSON.stringify(step)) progress.push(step);
    }
  }
  return { progress, outcome: reader.outcome() };
}

describe('claudeReader', () => {
  it('maps the partial stream to starting → thinking → writing and keeps the result', () => {
    const { progress, outcome } = replay('claude-partial.jsonl', claudeReader());
    expect(progress).toEqual([{ stage: 'starting' }, { stage: 'thinking' }, { stage: 'writing' }]);
    expect(outcome.text?.startsWith('- ')).toBe(true);
    expect(outcome).toMatchObject({ notLoggedIn: false, error: null });
  });

  it('shows each web fetch with its URL', () => {
    const { progress } = replay('claude-search-partial.jsonl', claudeReader());
    expect(progress[0]).toEqual({ stage: 'starting' });
    const fetching = progress.filter(step => step.stage === 'fetching');
    expect(fetching.length).toBeGreaterThanOrEqual(1);
    for (const step of fetching) expect(step).toMatchObject({ url: expect.stringMatching(/^https?:\/\//u) as unknown });
    expect(progress[progress.length - 1]).toEqual({ stage: 'writing' });
  });

  it('shows a web search with its query (the stage-0 stream without partial messages)', () => {
    const reader = claudeReader();
    expect(reader.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'obsidian changelog' } }] } })))
      .toEqual([{ stage: 'searching', query: 'obsidian changelog' }]);
  });

  it('tells "not logged in" from the error result (artifacts/lev-270 f3)', () => {
    const { outcome } = replay('claude-not-logged-in.jsonl', claudeReader());
    expect(outcome).toEqual({ text: null, notLoggedIn: true, error: 'Not logged in · Please run /login' });
  });

  it('keeps another error result as an error, not as the answer', () => {
    const reader = claudeReader();
    reader.line(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }));
    expect(reader.outcome()).toEqual({ text: null, notLoggedIn: false, error: 'error_max_turns' });
  });

  it('skips what it cannot read', () => {
    const reader = claudeReader();
    for (const line of ['', 'not json', '[1]', '{"type":"unknown"}', '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use"}}}']) {
      expect(reader.line(line)).toEqual([]);
    }
    expect(reader.outcome()).toEqual({ text: null, notLoggedIn: false, error: null });
  });
});

describe('codexReader', () => {
  it('takes the last agent message: a preamble can come as a message of its own (stage 0 #13)', () => {
    const { progress, outcome } = replay('codex-search.jsonl', codexReader());
    // A search starts before Codex has its words: thinking, not an empty 「検索中」.
    expect(progress).not.toContainEqual({ stage: 'searching', query: '' });
    expect(progress).toContainEqual({ stage: 'thinking' });
    expect(progress).toContainEqual({ stage: 'searching', query: 'site.obsidian.md/changelog latest desktop 2026 Obsidian' });
    expect(progress).toContainEqual({ stage: 'fetching', url: 'https://obsidian.md/changelog/2026-08-20-mobile-v1.13.8/' });
    expect(outcome.text).not.toContain('Web で調べ');
    expect(outcome.text?.split('\n').length).toBeGreaterThan(3);
  });

  it('shows commands as thinking without their text', () => {
    const { progress } = replay('codex-commands.jsonl', codexReader());
    expect(progress).toContainEqual({ stage: 'thinking' });
    expect(JSON.stringify(progress)).not.toContain('zsh');
  });

  it('reads the transcript summary', () => {
    const { progress, outcome } = replay('codex-transcript.jsonl', codexReader());
    expect(progress).toEqual([{ stage: 'writing' }]);
    expect(outcome.text?.startsWith('- ')).toBe(true);
  });

  it('tells "not logged in" from the failed turn after the retries (artifacts/lev-270 f4)', () => {
    const { outcome } = replay('codex-not-logged-in.jsonl', codexReader());
    expect(outcome.notLoggedIn).toBe(true);
    expect(outcome.text).toBeNull();
    expect(outcome.error).toContain('401 Unauthorized');
  });

  it('keeps no answer when the stream ends before the turn completed (a preamble is not the answer)', () => {
    const reader = codexReader();
    reader.line(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '- 素材を読みます' } }));
    expect(reader.outcome().text).toBeNull();
    reader.line(JSON.stringify({ type: 'turn.completed', usage: {} }));
    expect(reader.outcome().text).toBe('- 素材を読みます');
  });

  it('keeps no answer when the turn failed after a message', () => {
    const reader = codexReader();
    reader.line(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '- partial' } }));
    reader.line(JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }));
    expect(reader.outcome()).toEqual({ text: null, notLoggedIn: false, error: 'stream disconnected' });
  });
});
