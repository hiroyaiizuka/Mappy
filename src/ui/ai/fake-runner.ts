import type { AiProgress, AiRequest, AiResult, AiRunner, OutlineItem } from "../../ai/contract";

/** One step of a scripted run: the progress shown, `after` ms after the step before. */
export interface FakeStep { progress: AiProgress; after: number }

export interface FakeScript {
  /** The progress, in order; by default the stages a real run goes through for the request. */
  steps?: (request: AiRequest) => FakeStep[];
  /** What the run ends with, `after` ms after the last step; by default an outline made from the request (`fakeOutline`). */
  result?: (request: AiRequest) => AiResult;
  /** The wait between steps when `steps` is not given, and before the result. */
  interval?: number;
}

/** The stages a real run shows for `request` (§11.4 `AiProgress`), `interval` ms apart. */
export function fakeSteps(request: AiRequest, interval: number): FakeStep[] {
  const steps: AiProgress[] = [
    ...request.materials.map((material): AiProgress => ({ stage: "material", label: material.label })),
    { stage: "starting" },
    ...(request.webSearch ? [{ stage: "searching", query: request.instruction || request.context.title } as const] : []),
    { stage: "thinking" },
    { stage: "writing" },
  ];
  return steps.map(progress => ({ progress, after: interval }));
}

/**
 * An outline shaped by the request: three items at the top, each with children down to the depth asked for, their
 * text naming the node and the template, so a test or a person can tell which request it answers.
 */
export function fakeOutline(request: AiRequest): AiResult {
  const title = request.context.title.trim() || "—";
  const branch = (label: string, depth: number): OutlineItem => ({
    text: label,
    children: depth >= request.depth ? [] : [1, 2].map(index => branch(`${label}.${index}`, depth + 1)),
  });
  const items = [1, 2, 3].map(index => branch(`${title} ${request.template} ${index}`, 1));
  const raw = (list: OutlineItem[], depth: number): string[] => list.flatMap(item => [`${"  ".repeat(depth)}- ${item.text}`, ...raw(item.children, depth + 1)]);
  return { kind: "outline", items, dropped: 0, raw: raw(items, 0).join("\n") };
}

/**
 * The `AiRunner` with no CLI behind it (§11.4): it goes through the steps of `script` on timers and resolves with its
 * result, or with `cancelled` as soon as the signal aborts. The UI is built and tested on it (vitest, the browser
 * page), and a development build offers it as an engine for the E2E on the test vault (`AiServices.fakeRunner`).
 */
export class FakeRunner implements AiRunner {
  /** The requests run so far, in order: what the tests read to see what the input sent. */
  readonly requests: AiRequest[] = [];

  constructor(private readonly script: FakeScript = {}) {}

  run(request: AiRequest, onProgress: (progress: AiProgress) => void, signal: AbortSignal): Promise<AiResult> {
    this.requests.push(request);
    const interval = this.script.interval ?? 300;
    const steps = this.script.steps?.(request) ?? fakeSteps(request, interval);
    return new Promise<AiResult>(resolve => {
      let timer: number | undefined;
      let index = 0;
      const finish = (result: AiResult): void => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = (): void => {
        if (timer !== undefined) window.clearTimeout(timer);
        finish({ kind: "cancelled" });
      };
      const next = (): void => {
        const step = steps[index];
        if (!step) {
          timer = window.setTimeout(() => { finish(this.script.result?.(request) ?? fakeOutline(request)); }, interval);
          return;
        }
        timer = window.setTimeout(() => {
          index += 1;
          onProgress(step.progress);
          next();
        }, step.after);
      };
      if (signal.aborted) { finish({ kind: "cancelled" }); return; }
      signal.addEventListener("abort", abort);
      next();
    });
  }
}
