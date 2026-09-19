/**
 * Layer ② of docs/harness.md: the product's map view running in a plain
 * browser. `src/ui/mindmap-view.ts`, its renderer, viewport and events are the
 * shipped modules; only the `obsidian` module is replaced by ./obsidian.ts.
 * Saving, link resolution, themes and IME are Obsidian-only and stay out of scope.
 */
import type { App, WorkspaceLeaf as ObsidianLeaf } from "obsidian";
import { installObsidianDom } from "./dom";
import { Notice, WorkspaceLeaf } from "./obsidian";
import { HarnessApp } from "./app";
import { FIXTURES, SAMPLE_IMAGE, findFixture, type HarnessFixture } from "./fixtures";
import {
  installProbes, measureFrames, measureInlineEdit, measureLoad, measureMarkdownEdit,
  type EditSample, type FrameSample, type LoadSample, type MeasureContext,
} from "./measure";
import { captureScene, rasterizeSvg, type ImageResolver } from "../../src/export/svg-capture";
import { DESKTOP_PNG_LIMITS, buildSvg, pngScale, svgSize, type ExportTheme } from "../../src/export/svg-document";
import type { LayoutMode } from "../../src/layout/layout";
import { DocumentStore } from "../../src/obsidian/document-store";
import type { ViewRouter } from "../../src/obsidian/view-routing";
import { MindmapView } from "../../src/ui/mindmap-view";

declare const __MAPPY_HARNESS_BUILD__: { commit: string; builtAt: string };

// Product modules only touch the DOM inside methods, so installing here is early enough.
installObsidianDom();
// Frame and timer probes must wrap the window before the view schedules anything.
const probes = installProbes(window);

/** One fixture load with its stage times (docs/harness.md「時刻の記録」; measure.ts for the stages). */
export type HarnessTiming = LoadSample;

const PANE_PRESETS: readonly [label: string, width: number, height: number][] = [
  ["1280×800", 1280, 800], ["960×640", 960, 640], ["640×480", 640, 480], ["390×700（スマホ幅）", 390, 700],
];

const app = new HarnessApp();
for (const fixture of FIXTURES) app.put(fixture.path, fixture.source);
app.put(SAMPLE_IMAGE.path, "", SAMPLE_IMAGE.url);
const store = new DocumentStore(app.asApp<App>());
/** Markdown editors do not exist here; the router only reports the request. */
const router = {
  openMarkdown(): Promise<void> {
    new Notice("Markdown エディタはこのページの対象外です（③ 実機で確認）。");
    return Promise.resolve();
  },
} as unknown as ViewRouter;

const pane = mustFind<HTMLElement>("#harness-pane");
const fixtureSelect = mustFind<HTMLSelectElement>("#harness-fixture");
const coversEl = mustFind<HTMLElement>("#harness-covers");
const presetsEl = mustFind<HTMLElement>("#harness-presets");
const widthInput = mustFind<HTMLInputElement>("#harness-width");
const heightInput = mustFind<HTMLInputElement>("#harness-height");
const statusEl = mustFind<HTMLElement>("#harness-status");
const timingsEl = mustFind<HTMLElement>("#harness-timings");
const activityEl = mustFind<HTMLElement>("#harness-activity");
const buildEl = mustFind<HTMLElement>("#harness-build");

let view: MindmapView | null = null;
let current: HarnessFixture | null = null;
let openCount = 0;
const timings: HarnessTiming[] = [];

function mustFind<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}

/** The page's own waits use the native frame callback, so they are not counted as product frames. */
function nextFrame(): Promise<number> { return probes.nextFrame(); }

function nodePositions(): string {
  return Array.from(pane.querySelectorAll<HTMLElement>(".mappy-node"), node => `${node.dataset.nodeId}:${node.style.transform}`).join("|");
}

/** Resolve once node positions and the viewport stop changing, or after a bounded wait. */
async function settle(maxMs = 1500): Promise<void> {
  const started = performance.now();
  let previous = "";
  let stable = 0;
  while (performance.now() - started < maxMs) {
    await nextFrame();
    const snapshot = `${nodePositions()}#${view?.getState().viewport ? JSON.stringify(view.getState().viewport) : ""}`;
    stable = snapshot === previous ? stable + 1 : 0;
    previous = snapshot;
    if (stable >= 3) return;
  }
}

async function openView(): Promise<MindmapView> {
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const opened = new MindmapView(leaf as unknown as ObsidianLeaf, store, router);
  // MindmapView is typed against Obsidian's View; at runtime it extends the mock.
  leaf.view = opened as unknown as WorkspaceLeaf["view"];
  pane.replaceChildren(opened.containerEl);
  opened.load();
  await opened.onOpen();
  openCount += 1;
  return opened;
}

async function closeView(): Promise<void> {
  if (!view) return;
  const closing = view;
  view = null;
  await closing.onClose();
  closing.unload();
  closing.containerEl.remove();
}

/** `mode` opens the fixture in that layout (the performance runner measures all three); omitted, the note decides. */
async function load(id: string, mode?: LayoutMode): Promise<HarnessTiming> {
  const fixture = findFixture(id);
  if (!fixture) throw new Error(`Unknown fixture: ${id}`);
  current = fixture;
  fixtureSelect.value = fixture.id;
  coversEl.textContent = fixture.covers;
  const url = new URL(location.href);
  url.searchParams.set("fixture", fixture.id);
  history.replaceState(null, "", url);
  view ??= await openView();
  performance.mark(`mappy:load:${fixture.id}:start`);
  const timing = await measureLoad(measureContext, view, fixture, mode);
  performance.measure(`mappy:load:${fixture.id}`, `mappy:load:${fixture.id}:start`);
  timings.push(timing);
  renderTimings();
  const format = view.snapshot()?.document?.format === "list" ? "H2＋リスト" : "見出し";
  setStatus(`${fixture.label}: ${timing.nodes} ノード（${format}形式、${timing.mode}）、表示 ${openCount} 回目`);
  return timing;
}

function resize(width: number, height: number): void {
  pane.style.width = `${Math.max(120, Math.round(width))}px`;
  pane.style.height = `${Math.max(120, Math.round(height))}px`;
  widthInput.value = String(Math.round(width));
  heightInput.value = String(Math.round(height));
}

async function reopen(): Promise<HarnessTiming | null> {
  const fixture = current;
  await closeView();
  view = await openView();
  return fixture ? load(fixture.id) : null;
}

function setStatus(text: string): void { statusEl.textContent = text; }

const measureContext: MeasureContext = { probes, pane, vault: app.vault, settle };

function currentFile(): { fixture: HarnessFixture; file: unknown; view: MindmapView } {
  if (!current || !view) throw new Error("No fixture is loaded");
  const file = app.vault.getAbstractFileByPath(current.path);
  if (!file) throw new Error(`Fixture file missing: ${current.path}`);
  return { fixture: current, file, view };
}

/**
 * Timing probes for `scripts/browser-harness-perf.mjs`. Each load opens a fresh
 * view so repeated samples pay the full cost; edits run on the loaded fixture.
 */
const measure = {
  async load(id: string, mode?: LayoutMode): Promise<LoadSample> {
    await closeView();
    view = await openView();
    return load(id, mode);
  },
  markdownEdit(): Promise<EditSample> {
    const { fixture, file, view: opened } = currentFile();
    return measureMarkdownEdit(measureContext, opened, fixture, file);
  },
  inlineEdit(keystrokes = 20): Promise<EditSample[]> {
    const { fixture, view: opened } = currentFile();
    return measureInlineEdit(measureContext, opened, fixture, keystrokes);
  },
  frames(kind: "pan" | "zoom", frames = 60): Promise<FrameSample> {
    const { fixture, view: opened } = currentFile();
    return measureFrames(measureContext, opened, fixture, kind, frames);
  },
  /** Product frames and timers seen so far, for DevTools inspection. */
  probes,
};

/** What `h.export.svg()` hands the capture script: the file and the counts to check it against. */
export interface HarnessSvgExport {
  svg: string;
  width: number;
  height: number;
  nodes: number;
  edges: number;
  badges: number;
  images: number;
  theme: ExportTheme;
  ms: number;
}

export interface HarnessPngExport {
  dataUrl: string;
  width: number;
  height: number;
  scale: number;
  bytes: number;
  nodes: number;
  /** Capture and serialisation, then rasterisation. */
  svgMs: number;
  ms: number;
}

/** The page keeps the sample image as a data URL; attachments added on the page are blob URLs and are read back. */
const resolveHarnessImage: ImageResolver = async image => {
  const src = image.currentSrc || image.src;
  if (src.startsWith("data:")) return src;
  if (!src.startsWith("blob:")) return null;
  const blob = await (await fetch(src)).blob();
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.addEventListener("load", () => { resolve(typeof reader.result === "string" ? reader.result : null); }, { once: true });
    reader.addEventListener("error", () => { resolve(null); }, { once: true });
    reader.readAsDataURL(blob);
  });
};

/** M13 in this page: the same capture and document the plugin writes, minus the vault. */
async function exportSvg(): Promise<HarnessSvgExport> {
  if (!view) throw new Error("No fixture is loaded");
  const started = performance.now();
  const source = await view.exportSource();
  const scene = await captureScene(source, { resolveImage: resolveHarnessImage });
  const svg = buildSvg(scene);
  const size = svgSize(scene.bounds);
  return {
    svg, width: size.width, height: size.height, nodes: scene.nodes.length, edges: scene.edges.length, badges: scene.badges.length,
    images: (svg.match(/<img /gu) ?? []).length, theme: scene.theme, ms: performance.now() - started,
  };
}

async function exportPng(): Promise<HarnessPngExport> {
  const exported = await exportSvg();
  const started = performance.now();
  const size = { width: exported.width, height: exported.height };
  const scale = pngScale(size, DESKTOP_PNG_LIMITS);
  const blob = await rasterizeSvg(exported.svg, size, scale);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => { resolve(typeof reader.result === "string" ? reader.result : ""); }, { once: true });
    reader.addEventListener("error", () => { reject(new Error("PNG を読み戻せません")); }, { once: true });
    reader.readAsDataURL(blob);
  });
  return {
    dataUrl, scale, width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)),
    bytes: blob.size, nodes: exported.nodes, svgMs: exported.ms, ms: performance.now() - started,
  };
}

/** Page controls report failures in the status line instead of an unhandled rejection. */
function report(action: Promise<unknown>): void {
  action.catch((error: unknown) => { setStatus(error instanceof Error ? error.message : String(error)); });
}

function renderTimings(): void {
  timingsEl.replaceChildren();
  for (const timing of timings.slice(-8).reverse()) {
    const row = timingsEl.createEl("li");
    row.createEl("code", { text: timing.fixture });
    row.append(` ${timing.nodes} ノード（${timing.mode}）: parse ${timing.parseMs.toFixed(1)} ms / setState ${timing.stateMs.toFixed(1)} ms`
      + ` / 計測 ${timing.measureMs.toFixed(1)} ms / 配置フレーム ${timing.frameMs.toFixed(1)} ms（layoutTree ${timing.layoutMs.toFixed(1)} ms）`
      + ` / 初回配置 ${timing.firstLayoutMs.toFixed(1)} ms / 安定 ${timing.settledMs.toFixed(1)} ms`);
  }
}

function renderActivity(): void {
  activityEl.replaceChildren();
  for (const entry of app.activity.slice(-6).reverse()) {
    activityEl.createEl("li", { text: `${entry.kind}: ${entry.detail}` });
  }
}

interface PlainRect { x: number; y: number; width: number; height: number }

/** Plain objects survive CDP's returnByValue, DOMRect does not. */
function plainRect(element: Element | null | undefined): PlainRect | null {
  if (!element) return null;
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

function nodeInfo(element: HTMLElement): { id: string; title: string; rect: PlainRect; toggle: PlainRect | null; collapsed: boolean; selected: boolean } {
  const toggle = element.querySelector<HTMLElement>(".mappy-node-toggle");
  return {
    id: element.dataset.nodeId ?? "",
    title: element.querySelector(".mappy-node-label")?.textContent?.trim() ?? "",
    rect: plainRect(element) ?? { x: 0, y: 0, width: 0, height: 0 },
    toggle: toggle && !toggle.hidden ? plainRect(toggle) : null,
    collapsed: element.classList.contains("is-collapsed"),
    selected: element.classList.contains("is-selected"),
  };
}

/** Exposed for the capture script and manual DevTools use. */
const api = {
  build: __MAPPY_HARNESS_BUILD__,
  fixtures: FIXTURES.map(fixture => fixture.id),
  timings,
  activity: app.activity,
  notices: Notice.log,
  load,
  reopen,
  resize,
  settle,
  measure,
  get view() { return view; },
  get openCount() { return openCount; },
  viewport: () => view?.getState().viewport ?? null,
  canvasRect: () => plainRect(pane.querySelector(".mappy-canvas")),
  nodes: () => Array.from(pane.querySelectorAll<HTMLElement>(".mappy-node"), nodeInfo),
  node: (title: string) => {
    const element = Array.from(pane.querySelectorAll<HTMLElement>(".mappy-node"))
      .find(candidate => candidate.querySelector(".mappy-node-label")?.textContent?.trim() === title);
    return element ? nodeInfo(element) : null;
  },
  button: (label: string) => plainRect(pane.querySelector<HTMLElement>(`.mappy-button[aria-label="${label}"]`)),
  /** SVG／PNG export of the view as shown (§5 M13); nothing is saved, the capture script writes the files. */
  export: { svg: exportSvg, png: exportPng },
  /** The current fixture's Markdown as the in-memory vault holds it now (edits stay in this page). */
  source: () => {
    const file = current ? app.vault.getAbstractFileByPath(current.path) : null;
    return file ? app.content(file) : null;
  },
  ready: Promise.resolve(),
};
declare global { interface Window { __mappyHarness: typeof api } }
window.__mappyHarness = api;

function setupPanel(): void {
  buildEl.textContent = `build ${__MAPPY_HARNESS_BUILD__.commit} (${__MAPPY_HARNESS_BUILD__.builtAt})`;
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const fixture of FIXTURES) {
    const label = fixture.performance ? `性能: ${fixture.performance.shape}` : "静的";
    let group = groups.get(label);
    if (!group) { group = fixtureSelect.createEl("optgroup", { attr: { label } }); groups.set(label, group); }
    group.createEl("option", { value: fixture.id, text: fixture.label });
  }
  fixtureSelect.addEventListener("change", () => { report(load(fixtureSelect.value)); });
  for (const [label, width, height] of PANE_PRESETS) {
    const button = presetsEl.createEl("button", { text: label, attr: { type: "button" } });
    button.addEventListener("click", () => { resize(width, height); });
  }
  const applySize = (): void => { resize(Number(widthInput.value), Number(heightInput.value)); };
  widthInput.addEventListener("change", applySize);
  heightInput.addEventListener("change", applySize);
  mustFind<HTMLButtonElement>("#harness-reopen").addEventListener("click", () => { report(reopen()); });
  new ResizeObserver(() => {
    widthInput.value = String(Math.round(pane.offsetWidth));
    heightInput.value = String(Math.round(pane.offsetHeight));
    // Obsidian calls onResize when the leaf changes size; the page does the same.
    view?.onResize();
  }).observe(pane);
  window.setInterval(renderActivity, 500);
}

const params = new URL(location.href).searchParams;
setupPanel();
resize(Number(params.get("width")) || 1280, Number(params.get("height")) || 800);
api.ready = load(findFixture(params.get("fixture"))?.id ?? "uneven-branches").then(() => undefined);
report(api.ready);
