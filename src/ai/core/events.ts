import type { AiProgress } from '../contract';

/**
 * Reading the CLIs' event streams line by line (docs/architecture.md §11.4): Claude's `--output-format stream-json`
 * (with `--include-partial-messages`) and Codex's `exec --json`. Each reader turns a line into progress and keeps
 * what the run ends with. A line that is not JSON, or an event it does not know, is skipped: the shapes change
 * between versions and that must not stop a run.
 */

export interface StreamOutcome {
  /** The final answer: Claude's `result`, Codex's last `agent_message`. Null when none came. */
  text: string | null;
  /** The CLI reported it is not logged in (or has no valid API key). */
  notLoggedIn: boolean;
  /** An error the CLI reported in its stream (Claude's error result, Codex's `turn.failed`). */
  error: string | null;
}

export interface StreamReader {
  /** The progress one line of standard output means (often none). */
  line(text: string): AiProgress[];
  outcome(): StreamOutcome;
}

type Json = Record<string, unknown>;

function parse(text: string): Json | null {
  if (!text.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Claude's way of saying so: the synthetic answer「Not logged in · Please run /login」, `authentication_failed`, a bad key. */
const CLAUDE_NOT_LOGGED_IN = /not logged in|please run \/login|invalid api key|authentication_failed|oauth token (?:has )?expired/iu;
/** Codex retries a missing or rejected login and then fails the turn with the HTTP status. */
const CODEX_NOT_LOGGED_IN = /\b401\b|unauthorized|not logged in|please (?:log ?in|run `?codex login)/iu;

function toolProgress(name: string, input: Json | null): AiProgress | null {
  if (name === 'WebSearch') return { stage: 'searching', query: string(input?.query) };
  if (name === 'WebFetch') return { stage: 'fetching', url: string(input?.url) };
  return null;
}

export function claudeReader(): StreamReader {
  let text: string | null = null;
  let error: string | null = null;
  let notLoggedIn = false;
  return {
    line(line) {
      const event = parse(line);
      if (!event) return [];
      switch (event.type) {
        case 'system':
          return event.subtype === 'init' ? [{ stage: 'starting' }] : [];
        case 'stream_event': {
          // Partial messages: the block that begins tells what the model is doing now.
          const inner = record(event.event);
          const block = record(inner?.content_block);
          if (inner?.type !== 'content_block_start' || !block) return [];
          if (block.type === 'thinking' || block.type === 'redacted_thinking') return [{ stage: 'thinking' }];
          if (block.type === 'text') return [{ stage: 'writing' }];
          return [];
        }
        case 'assistant': {
          const message = record(event.message);
          if (event.error === 'authentication_failed') notLoggedIn = true;
          const content = Array.isArray(message?.content) ? message.content : [];
          const progress: AiProgress[] = [];
          for (const part of content) {
            const block = record(part);
            if (block?.type !== 'tool_use') continue;
            // The tool's input arrives whole here (the partial stream sends it in pieces).
            const step = toolProgress(string(block.name), record(block.input));
            if (step) progress.push(step);
          }
          return progress;
        }
        case 'result': {
          const result = string(event.result);
          if (event.is_error === true) {
            error = result || string(event.subtype) || 'error';
            if (CLAUDE_NOT_LOGGED_IN.test(result)) notLoggedIn = true;
          } else {
            text = result;
          }
          return [];
        }
        default:
          return [];
      }
    },
    outcome: () => ({ text, notLoggedIn, error }),
  };
}

export function codexReader(): StreamReader {
  let last: string | null = null;
  let error: string | null = null;
  let notLoggedIn = false;
  return {
    line(line) {
      const event = parse(line);
      if (!event) return [];
      const item = record(event.item);
      switch (event.type) {
        case 'item.started':
          if (item?.type === 'web_search') return [{ stage: 'searching', query: string(item.query) }];
          // The command itself is not shown: it may name files outside the vault.
          if (item?.type === 'command_execution') return [{ stage: 'thinking' }];
          if (item?.type === 'reasoning') return [{ stage: 'thinking' }];
          return [];
        case 'item.completed': {
          if (item?.type === 'agent_message') {
            // A preamble can come as its own message before the answer: the last one is the answer.
            last = string(item.text);
            return [{ stage: 'writing' }];
          }
          if (item?.type === 'web_search') {
            const action = record(item.action);
            if (action?.type === 'open_page') return [{ stage: 'fetching', url: string(action.url) }];
            const query = string(action?.query) || string(item.query);
            return query ? [{ stage: 'searching', query }] : [];
          }
          return [];
        }
        case 'turn.failed': {
          const message = string(record(event.error)?.message) || 'turn failed';
          error = message;
          if (CODEX_NOT_LOGGED_IN.test(message)) notLoggedIn = true;
          return [];
        }
        default:
          return [];
      }
    },
    outcome: () => ({ text: error === null ? last : null, notLoggedIn, error }),
  };
}
