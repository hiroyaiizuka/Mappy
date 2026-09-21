/**
 * Timing probes for the map view's load and edit paths (product-plan §6, LEV-13).
 *
 * Everything here observes the shipped view from outside: the page's own
 * requestAnimationFrame / setTimeout are wrapped so the view's layout frame and
 * refresh debounce show up with start and end times, a MutationObserver on the
 * edited node marks when its DOM changed, and the pure core / layout functions
 * are timed once more on the same input. src/ stays untouched, so the numbers
 * describe the product's pipeline as shipped, plus the browser work it forces.
 */
import type { ViewStateResult } from "obsidian";
import { applyEdits, planEdit } from "../../src/core/commands";
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from "../../src/core/markdown";
import { layoutTree, type LayoutMode, type NodeSize } from "../../src/layout/layout";
import type { MindmapView } from "../../src/ui/mindmap-view";

export interface FrameRecord {
  requestedAt: number;
  /** The requestAnimationFrame timestamp: identifies the frame the callback ran in. */
  frameTime: number;
  startedAt: number;
  endedAt: number;
}

export interface TimerRecord {
  requestedAt: number;
  delay: number;
  /** NaN until the callback ran. */
  startedAt: number;
  endedAt: number;
}

export interface Probes {
  /** Product requestAnimationFrame callbacks in execution order (the view's layout frames). */
  readonly frames: FrameRecord[];
  /** Product timers in scheduling order (the view's 45 ms refresh debounce, notices, ...). */
  readonly timers: TimerRecord[];
  /** The native requestAnimationFrame, so the page's own waits are not recorded as product frames. */
  nextFrame(): Promise<number>;
}

const RECORD_LIMIT = 4000;

/** Wrap the window's frame and timer scheduling once; product code sees the wrapped functions through `el.win`. */
export function installProbes(win: Window): Probes {
  const frames: FrameRecord[] = [];
  const timers: TimerRecord[] = [];
  const nativeFrame = win.requestAnimationFrame.bind(win);
  const nativeTimeout = win.setTimeout.bind(win);
  win.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const requestedAt = performance.now();
    return nativeFrame(timestamp => {
      const startedAt = performance.now();
      try { callback(timestamp); }
      finally {
        frames.push({ requestedAt, frameTime: timestamp, startedAt, endedAt: performance.now() });
        if (frames.length > RECORD_LIMIT) frames.splice(0, frames.length - RECORD_LIMIT);
      }
    });
  };
  win.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]): number => {
    if (typeof handler !== "function") return nativeTimeout(handler, delay);
    const callback = handler as (...data: unknown[]) => void;
    const record: TimerRecord = { requestedAt: performance.now(), delay: delay ?? 0, startedAt: NaN, endedAt: NaN };
    timers.push(record);
    if (timers.length > RECORD_LIMIT) timers.splice(0, timers.length - RECORD_LIMIT);
    return nativeTimeout(() => {
      record.startedAt = performance.now();
      try { callback(...args); }
      finally { record.endedAt = performance.now(); }
    }, delay);
  }) as typeof win.setTimeout;
  return {
    frames, timers,
    nextFrame: () => new Promise<number>(resolve => { nativeFrame(resolve); }),
  };
}

/** What the page hands the probes: the pane holding the view and the vault stand-in. */
export interface MeasureContext {
  probes: Probes;
  pane: HTMLElement;
  vault: { process(file: unknown, change: (current: string) => string): Promise<string> };
  /** Wait until node positions and the viewport stop changing. */
  settle(maxMs?: number): Promise<void>;
}

export interface LoadSample {
  kind: "load";
  fixture: string;
  /** The layout the view placed the map in; product-plan §6 records every layout. */
  mode: LayoutMode;
  nodes: number;
  /** parseMarkdown alone on the same text. */
  parseMs: number;
  /** setState resolved: read, the view's parse, node DOM created and labels rendered. */
  stateMs: number;
  /**
   * First offsetWidth read right after setState: the browser's style + layout for the
   * new nodes. The view pays the same in `sizes()` unless the browser already laid
   * out in idle time; reading here makes the stage visible either way.
   */
  measureMs: number;
  /** layoutTree alone with the measured sizes. */
  layoutMs: number;
  /** The view's layout frame callback (sizes, layoutTree, place, edges, Fit). */
  frameMs: number;
  /** End of that callback → next frame start: style, layout, paint of the placed map. ≤ ~17 ms means within one frame. */
  paintMs: number;
  /** setState start → end of the layout frame. */
  firstLayoutMs: number;
  /** setState start → positions stable for three frames (image loads included). */
  settledMs: number;
  /** Product frames from setState until settled. */
  frames: number;
  at: string;
}

export interface EditSample {
  kind: "markdown-edit" | "inline-key" | "inline-commit";
  fixture: string;
  mode: LayoutMode;
  nodes: number;
  /** Edited node title before the change. */
  target: string;
  /** Change → the refresh debounce fired (markdown-edit only; 0 otherwise). */
  debounceMs: number;
  /** parseMarkdown alone, with the previous document for ID matching (0 for inline-key). */
  parseMs: number;
  /**
   * Synchronous work before the frame: debounce fired → the node's DOM updated (read,
   * parse, node DOM) for markdown-edit; Enter → node DOM updated (apply, read, parse,
   * node DOM) for inline-commit; the input handler (textarea resize) for inline-key.
   */
  refreshMs: number;
  /** DOM updated (or change) → the layout frame started. */
  waitMs: number;
  frameMs: number;
  paintMs: number;
  /** Change → the frame after the layout frame started. */
  totalMs: number;
  /** Change → positions stable and every pending refresh drained. */
  settledMs: number;
  at: string;
}

export interface FrameSample {
  kind: "pan" | "zoom";
  fixture: string;
  mode: LayoutMode;
  nodes: number;
  /** requestAnimationFrame timestamp deltas while one wheel event is dispatched per frame. */
  intervals: number[];
  /** Synchronous cost of each wheel dispatch (the product's handler); the rest of the interval is the browser. */
  handlerMs: number[];
  at: string;
}

export interface TopicDragSample {
  kind: "topic-drag";
  fixture: string;
  mode: LayoutMode;
  /** Nodes on the map while it is dragged: the fixture's, plus the one the appended topic adds. */
  nodes: number;
  /** Pointer moves dispatched, one per frame. */
  moves: number;
  /** Of those, the ones whose pointer sat on empty canvas, where the view searches the map for a snap slot. */
  snapMoves: number;
  /** Of those, the ones that ended with a slot previewed for the dragged topic; 0 while it is carried clear of every node. */
  slots: number;
  /** Synchronous cost of each pointer move: the view shifts the carried tree and searches for a slot. */
  handlerMs: number[];
  /** The view's own layout frames during the drag (sizes, layoutTree, place, edges). */
  frameMs: number[];
  /** requestAnimationFrame timestamp deltas while one pointer move is dispatched per frame. */
  intervals: number[];
  at: string;
}

export type PerformanceSample = LoadSample | EditSample | FrameSample | TopicDragSample;

export const EDIT_MARK = "（編集）";

function now(): number { return performance.now(); }

function nodeElement(pane: HTMLElement, id: string): HTMLElement {
  const element = Array.from(pane.querySelectorAll<HTMLElement>(".mappy-node")).find(node => node.dataset.nodeId === id);
  if (!element) throw new Error(`Node ${id} is not in the DOM`);
  return element;
}

function nodeSizes(pane: HTMLElement): Map<string, NodeSize> {
  return new Map(Array.from(pane.querySelectorAll<HTMLElement>(".mappy-node"), node => [
    node.dataset.nodeId ?? "", { width: node.offsetWidth, height: node.offsetHeight },
  ]));
}

function documentOf(view: MindmapView): MindDocument {
  const document = view.snapshot()?.document;
  if (!document) throw new Error("The view has not parsed its note");
  return document;
}

function modeOf(view: MindmapView): LayoutMode {
  return view.snapshot()?.mode ?? "mindmap";
}

/**
 * The node an edit touches: the first child of the visual root that has children
 * (so a wider title moves a branch), else the first child, else the root when it
 * is a real heading. Never the virtual root, which cannot be renamed.
 */
export function editTarget(document: MindDocument): MindNode {
  const { root } = projectMap(document);
  const target = root.children.find(node => node.children.length > 0) ?? root.children[0]
    ?? (root.kind !== "root" ? root : undefined);
  if (!target) throw new Error("The document has no editable node");
  return target;
}

/** The title with the edit mark toggled, so repeated samples alternate between two widths. */
export function toggledTitle(title: string): string {
  return title.endsWith(EDIT_MARK) ? title.slice(0, -EDIT_MARK.length) : `${title}${EDIT_MARK}`;
}

function replaceTitle(document: MindDocument, node: MindNode, title: string): string {
  return `${document.source.slice(0, node.titleFrom)}${title}${document.source.slice(node.titleTo)}`;
}

/** Resolve at the first DOM change inside `element`, with its time. */
function observeChange(element: Element): Promise<number> {
  return new Promise(resolve => {
    const observer = new MutationObserver(() => { observer.disconnect(); resolve(now()); });
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
  });
}

/**
 * Native frames until the product ran a frame past `index`. Resolves with that
 * record and the start of the frame after it (the first frame that can show the
 * result); when the poll lands in the product's own frame it waits one more.
 */
async function productFrame(probes: Probes, index: number, maxMs = 5000): Promise<{ frame: FrameRecord; nextFrameAt: number }> {
  const started = now();
  for (;;) {
    const timestamp = await probes.nextFrame();
    const at = now();
    const frame = probes.frames[index];
    if (!frame) {
      if (at - started > maxMs) throw new Error("The view did not run a layout frame");
      continue;
    }
    // The poll's own clock, not the frame timestamp: the two share a time base in browsers but not in jsdom.
    if (frame.frameTime !== timestamp) return { frame, nextFrameAt: at };
    await probes.nextFrame();
    return { frame, nextFrameAt: now() };
  }
}

/** Timers longer than this are notices and the like, not refresh debounces. */
const REFRESH_TIMER_MAX_MS = 500;

/**
 * Wait until every refresh timer scheduled since `timerIndex` fired and two
 * consecutive frames passed without a product frame. Each sample starts from a
 * quiet view, so a trailing debounced refresh never lands in the next sample.
 */
async function drain(probes: Probes, timerIndex: number, maxMs = 5000): Promise<void> {
  const started = now();
  let seen = -1;
  let quiet = 0;
  for (;;) {
    await probes.nextFrame();
    const pending = probes.timers.slice(timerIndex)
      .some(timer => timer.delay <= REFRESH_TIMER_MAX_MS && Number.isNaN(timer.startedAt));
    quiet = !pending && probes.frames.length === seen ? quiet + 1 : 0;
    seen = probes.frames.length;
    if (quiet >= 2) return;
    if (now() - started > maxMs) throw new Error("Pending refreshes did not drain");
  }
}

function stamp(): string { return new Date().toISOString(); }

/**
 * Open `path` in a fresh view and time each stage. The size read follows setState
 * synchronously, so it precedes the view's layout frame and pays the browser layout
 * the view would otherwise pay inside `sizes()`. `mode` opens the note in that
 * layout the way a restored view state does; without it the note's own
 * `mappy-layout` (or the mind map) applies.
 */
export async function measureLoad(
  context: MeasureContext, view: MindmapView, fixture: { id: string; path: string; source: string }, mode?: LayoutMode,
): Promise<LoadSample> {
  const { probes, pane } = context;
  const basename = fixture.path.split("/").pop()?.replace(/\.md$/u, "") ?? fixture.id;
  const parseStart = now();
  const parsed = parseMarkdown(fixture.source, basename);
  const parseMs = now() - parseStart;
  const frameIndex = probes.frames.length;
  const start = now();
  await view.setState({ file: fixture.path, ...(mode ? { layout: mode } : {}) }, { history: false } satisfies ViewStateResult);
  const stateMs = now() - start;
  const measureStart = now();
  const sizes = nodeSizes(pane);
  const measureMs = now() - measureStart;
  const { frame, nextFrameAt } = await productFrame(probes, frameIndex);
  const firstLayoutMs = frame.endedAt - start;
  await context.settle();
  const settledMs = now() - start;
  const projection = projectMap(parsed);
  const placed = modeOf(view);
  const layoutStart = now();
  layoutTree(projection.root, sizes, new Set(), placed, projection.topics.map(topic => ({ tree: topic, position: null })));
  const layoutMs = now() - layoutStart;
  return {
    kind: "load", fixture: fixture.id, mode: placed, nodes: parsed.nodes.length,
    parseMs, stateMs, measureMs, layoutMs, frameMs: frame.endedAt - frame.startedAt, paintMs: nextFrameAt - frame.endedAt,
    firstLayoutMs, settledMs, frames: probes.frames.length - frameIndex, at: stamp(),
  };
}

/**
 * A Markdown-side change: the vault reports `modify`, the view debounces, re-reads,
 * parses, updates the node DOM and lays out on the next frame. Mirrors typing in
 * Obsidian's editor, minus the editor itself.
 */
export async function measureMarkdownEdit(
  context: MeasureContext, view: MindmapView, fixture: { id: string; path: string }, file: unknown,
): Promise<EditSample> {
  const { probes, pane } = context;
  const document = documentOf(view);
  const target = editTarget(document);
  const next = replaceTitle(document, target, toggledTitle(target.title));
  const parseStart = now();
  const parsed = parseMarkdown(next, document.root.title, document);
  const parseMs = now() - parseStart;
  const timerIndex = probes.timers.length;
  const frameIndex = probes.frames.length;
  const content = nodeElement(pane, target.id).querySelector(".mappy-node-content");
  if (!content) throw new Error("Node content missing");
  const changed = observeChange(content);
  const t0 = now();
  await context.vault.process(file, () => next);
  const timer = probes.timers[timerIndex];
  if (!timer) throw new Error("The view did not schedule a refresh after modify");
  const t2 = await changed;
  const { frame, nextFrameAt } = await productFrame(probes, frameIndex);
  await drain(probes, timerIndex);
  await context.settle();
  return {
    kind: "markdown-edit", fixture: fixture.id, mode: modeOf(view), nodes: parsed.nodes.length, target: target.title,
    debounceMs: timer.startedAt - t0, parseMs, refreshMs: t2 - timer.startedAt, waitMs: frame.startedAt - t2,
    frameMs: frame.endedAt - frame.startedAt, paintMs: nextFrameAt - frame.endedAt, totalMs: nextFrameAt - t0,
    settledMs: now() - t0, at: stamp(),
  };
}

function keydown(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
}

/**
 * Map-side editing through the real DOM path: click the node, F2, one keystroke
 * per sample (the inline editor resizes and the view lays out on the next frame),
 * then Enter (the rename is applied, re-read, re-rendered and laid out).
 */
export async function measureInlineEdit(
  context: MeasureContext, view: MindmapView, fixture: { id: string; path: string }, keystrokes: number,
): Promise<EditSample[]> {
  const { probes, pane } = context;
  const document = documentOf(view);
  const mode = modeOf(view);
  const target = editTarget(document);
  const canvas = pane.querySelector<HTMLElement>(".mappy-canvas");
  if (!canvas) throw new Error("Canvas missing");
  const element = nodeElement(pane, target.id);
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  keydown(canvas, "F2");
  const input = pane.querySelector<HTMLTextAreaElement>("textarea.mappy-inline-input");
  if (!input) throw new Error("The inline editor did not open");
  await drain(probes, probes.timers.length);
  const samples: EditSample[] = [];
  const base = toggledTitle(target.title);
  for (let index = 1; index <= keystrokes; index += 1) {
    const frameIndex = probes.frames.length;
    const t0 = now();
    input.value = `${base}${"あ".repeat(index)}`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const t2 = now();
    const { frame, nextFrameAt } = await productFrame(probes, frameIndex);
    samples.push({
      kind: "inline-key", fixture: fixture.id, mode, nodes: document.nodes.length, target: target.title,
      debounceMs: 0, parseMs: 0, refreshMs: t2 - t0, waitMs: frame.startedAt - t2,
      frameMs: frame.endedAt - frame.startedAt, paintMs: nextFrameAt - frame.endedAt, totalMs: nextFrameAt - t0,
      settledMs: now() - t0, at: stamp(),
    });
  }
  input.value = base;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await drain(probes, probes.timers.length);
  const parseStart = now();
  const parsed = parseMarkdown(replaceTitle(document, target, base), document.root.title, document);
  const parseMs = now() - parseStart;
  const timerIndex = probes.timers.length;
  const frameIndex = probes.frames.length;
  const content = element.querySelector(".mappy-node-content");
  if (!content) throw new Error("Node content missing");
  const changed = observeChange(content);
  const t0 = now();
  keydown(input, "Enter");
  const t2 = await changed;
  const { frame, nextFrameAt } = await productFrame(probes, frameIndex);
  await drain(probes, timerIndex);
  await context.settle();
  if (pane.querySelector("textarea.mappy-inline-input")) throw new Error("The inline editor did not close after Enter");
  samples.push({
    kind: "inline-commit", fixture: fixture.id, mode, nodes: parsed.nodes.length, target: target.title,
    debounceMs: 0, parseMs, refreshMs: t2 - t0, waitMs: frame.startedAt - t2,
    frameMs: frame.endedAt - frame.startedAt, paintMs: nextFrameAt - frame.endedAt, totalMs: nextFrameAt - t0,
    settledMs: now() - t0, at: stamp(),
  });
  return samples;
}

/**
 * One wheel event per frame for `frames` frames, half one way and half back, and
 * the frame timestamps between them. The handler only sets a transform, so the
 * intervals show what the browser spends on the moved or rescaled map.
 */
export async function measureFrames(
  context: MeasureContext, view: MindmapView, fixture: { id: string }, kind: "pan" | "zoom", frames = 60,
): Promise<FrameSample> {
  const { probes, pane } = context;
  const canvas = pane.querySelector<HTMLElement>(".mappy-canvas");
  if (!canvas) throw new Error("Canvas missing");
  const rect = canvas.getBoundingClientRect();
  const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const intervals: number[] = [];
  const handlerMs: number[] = [];
  let last = await probes.nextFrame();
  for (let index = 0; index < frames; index += 1) {
    const direction = index < frames / 2 ? 1 : -1;
    const dispatched = now();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      ...point, bubbles: true, cancelable: true, deltaMode: 0,
      deltaY: kind === "pan" ? 12 * direction : 20 * direction, ctrlKey: kind === "zoom",
    }));
    handlerMs.push(now() - dispatched);
    const timestamp = await probes.nextFrame();
    intervals.push(timestamp - last);
    last = timestamp;
  }
  await context.settle();
  return { kind, fixture: fixture.id, mode: modeOf(view), nodes: documentOf(view).nodes.length, intervals, handlerMs, at: stamp() };
}

/** The free topic a drag sample appends to the note, carries across the canvas, and removes again. */
export const DRAG_TOPIC_TITLE = "運ぶトピック";

/** How far apart the probe samples the pane while looking for canvas the pointer can travel over. */
const DRAG_PROBE_STEP = 16;
/** A run of empty canvas shorter than this cannot carry a drag; the sample fails rather than measure a still pointer. */
const DRAG_TRAVEL_MIN = 96;

/** A straight run of empty canvas, in client pixels. */
interface DragPath { y: number; from: number; to: number }

/**
 * The note with one more top-level section, so the map gains a free topic. The product's own planner
 * writes it: it takes the level from the last section (2 for a list document), keeps the note's tail,
 * re-parses in the note's own format and refuses a result that is not exactly one added topic.
 */
export function withDragTopic(document: MindDocument): string {
  return applyEdits(document.source, planEdit(document, { type: "add-topic", title: DRAG_TOPIC_TITLE }).edits);
}

/** True where `NodeDrag.move` finds no node under the pointer, so the view searches the map for a snap slot instead. */
function openAt(canvas: HTMLElement, x: number, y: number): boolean {
  const hit = canvas.doc.elementFromPoint(x, y);
  return Boolean(hit && canvas.contains(hit) && !hit.closest(".mappy-node, [data-drop-placeholder]"));
}

/**
 * The longest straight run of empty canvas in the pane. Fit leaves at least FIT_PADDING around the
 * map, so a band past its nodes is where a carried topic is judged by the snap search rather than by
 * the node under the pointer. Sampled with the hit test `NodeDrag.move` itself makes.
 */
function dragPath(canvas: HTMLElement): DragPath | null {
  const rect = canvas.getBoundingClientRect();
  const left = rect.left + DRAG_PROBE_STEP;
  const right = rect.right - DRAG_PROBE_STEP;
  let best: DragPath | null = null;
  const longest = (): number => (best ? best.to - best.from : 0);
  for (let y = rect.top + DRAG_PROBE_STEP; y <= rect.bottom - DRAG_PROBE_STEP; y += DRAG_PROBE_STEP) {
    let start: number | null = null;
    for (let x = left; x <= right + DRAG_PROBE_STEP; x += DRAG_PROBE_STEP) {
      if (x <= right && openAt(canvas, x, y)) { start ??= x; continue; }
      if (start !== null && x - DRAG_PROBE_STEP - start > longest()) best = { y, from: start, to: x - DRAG_PROBE_STEP };
      start = null;
    }
    // One run long enough is all a drag needs; every further row costs a forced hit test per sample point.
    if (longest() >= DRAG_TRAVEL_MIN) break;
  }
  return longest() >= DRAG_TRAVEL_MIN ? best : null;
}

/** Where the pointer sits on move `index`: out along the run and back, so the carried tree crosses the same canvas twice. */
function dragPoint(path: DragPath, index: number, moves: number): { x: number; y: number } {
  const half = Math.max(1, Math.floor(moves / 2));
  const step = Math.min(half, index < half ? index + 1 : Math.max(0, moves - index - 1));
  return { x: path.from + (path.to - path.from) * (step / half), y: path.y };
}

function pointer(target: EventTarget, type: string, x: number, y: number): void {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true, clientX: x, clientY: y,
  }));
}

/** Write the note and wait until the view has re-read it and gone quiet again. */
async function writeNote(context: MeasureContext, file: unknown, next: string): Promise<void> {
  const timerIndex = context.probes.timers.length;
  await context.vault.process(file, () => next);
  await drain(context.probes, timerIndex);
  await context.settle();
}

/**
 * A free topic carried across empty canvas (§5 M7). The note gains one top-level section, the pointer
 * presses that topic's root and moves once per frame along a run of empty canvas, and the note is put
 * back. Over empty canvas the view judges the slot from where the carried root sits, which reads the
 * whole map on every move (`MindmapView.snapTarget`): `handlerMs` is that search plus the shift it
 * follows, and `frameMs` the layout frame the shift schedules. Escape ends the drag, so no move is
 * ever written to the note.
 */
export async function measureTopicDrag(
  context: MeasureContext, view: MindmapView, fixture: { id: string }, file: unknown, moves = 60,
): Promise<TopicDragSample> {
  const { probes, pane } = context;
  const canvas = pane.querySelector<HTMLElement>(".mappy-canvas");
  if (!canvas) throw new Error("Canvas missing");
  const source = documentOf(view).source;
  try {
    await writeNote(context, file, withDragTopic(documentOf(view)));
    const topic = projectMap(documentOf(view)).topics.find(node => node.title === DRAG_TOPIC_TITLE);
    if (!topic) throw new Error("The appended section did not become a free topic");
    // Fit again: the samples before this one panned, zoomed and edited, and the drag needs the band Fit
    // leaves. Missing it would measure an undocumented viewport, so a missing button fails the sample.
    const fit = pane.querySelector<HTMLButtonElement>('.mappy-button[aria-label="全体表示"]');
    if (!fit) throw new Error("The 全体表示 button is missing");
    fit.click();
    await context.settle();
    const path = dragPath(canvas);
    if (!path) throw new Error("No run of empty canvas wide enough to carry a topic");
    const element = nodeElement(pane, topic.id);
    const box = element.getBoundingClientRect();
    pointer(element, "pointerdown", box.left + box.width / 2, box.top + box.height / 2);
    // One unmeasured move starts the drag: less travel than PRESS_TRAVEL is still a click on the node.
    const first = dragPoint(path, 0, moves);
    pointer(canvas, "pointermove", first.x, first.y);
    if (!canvas.classList.contains("is-dragging-node")) throw new Error("The press did not become a drag");
    const handlerMs: number[] = [];
    const intervals: number[] = [];
    let snapMoves = 0;
    let slots = 0;
    // After the frame that move scheduled: the drag's first layout is the one that takes the hold and
    // measures every node, which no later move pays. Frames are collected from here, one per move.
    let last = await probes.nextFrame();
    const frameMs: number[] = [];
    // Taken each move rather than sliced from one index at the end: `installProbes` trims its record from
    // the front past RECORD_LIMIT, so an index kept across a whole run would quietly drift.
    let seen = probes.frames.length;
    for (let index = 0; index < moves; index += 1) {
      const point = dragPoint(path, index, moves);
      const dispatched = now();
      pointer(canvas, "pointermove", point.x, point.y);
      handlerMs.push(now() - dispatched);
      // Read after the move, never before it: a hit test flushes the style and layout the previous frame
      // left pending, which `NodeDrag.move` pays inside the window above by reading its own rectangles.
      if (openAt(canvas, point.x, point.y)) snapMoves += 1;
      if (element.classList.contains("is-merging")) slots += 1;
      const timestamp = await probes.nextFrame();
      for (const frame of probes.frames.slice(seen)) frameMs.push(frame.endedAt - frame.startedAt);
      seen = probes.frames.length;
      intervals.push(timestamp - last);
      last = timestamp;
    }
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await context.settle();
    return {
      kind: "topic-drag", fixture: fixture.id, mode: modeOf(view), nodes: documentOf(view).nodes.length,
      moves, snapMoves, slots, handlerMs, frameMs, intervals, at: stamp(),
    };
  } finally {
    // The next samples of this fixture read the same note, and the runner's recovery only re-opens the
    // view; a restore that did not take would leave them measuring a different document without saying so.
    await writeNote(context, file, source);
    const left = documentOf(view).source;
    if (left !== source) throw new Error(`The fixture was left with the drag topic in it (${left.length} bytes, expected ${source.length})`);
  }
}
