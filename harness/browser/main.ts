/**
 * Layer ② of docs/harness.md: the product's map view running in a plain
 * browser. `src/ui/mindmap-view.ts`, its renderer, viewport and events are the
 * shipped modules; only the `obsidian` module is replaced by ./obsidian.ts.
 * Saving, link resolution, themes and IME are Obsidian-only and stay out of scope.
 */
import type { App, MarkdownPostProcessorContext, WorkspaceLeaf as ObsidianLeaf } from "obsidian";
import { installObsidianDom } from "./dom";
import { Component, MarkdownRenderer, Notice, WorkspaceLeaf, parseLinktext } from "./obsidian";
import { HarnessApp } from "./app";
import { EMBED_HOSTS, EMBED_TARGETS, FIXTURES, SAMPLE_IMAGE, findFixture, findHost, type HarnessFixture, type HarnessHost } from "./fixtures";
import {
  installProbes, measureFrames, measureInlineEdit, measureLoad, measureMarkdownEdit,
  type EditSample, type FrameSample, type LoadSample, type MeasureContext,
} from "./measure";
import type { LayoutMode } from "../../src/layout/layout";
import { DocumentStore } from "../../src/obsidian/document-store";
import type { ViewRouter } from "../../src/obsidian/view-routing";
import { MapEmbeds } from "../../src/ui/map-embed";
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
for (const target of EMBED_TARGETS) app.put(target.path, target.source);
for (const host of EMBED_HOSTS) app.put(host.path, host.source);
app.put(SAMPLE_IMAGE.path, "", SAMPLE_IMAGE.url);
const store = new DocumentStore(app.asApp<App>());
/** The shipped post processor for `![[map]]` (§5 M10); the page plays Obsidian's renderer around it. */
const embeds = new MapEmbeds(app.asApp<App>(), store);
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
const themeInput = mustFind<HTMLInputElement>("#harness-theme");

let view: MindmapView | null = null;
let current: HarnessFixture | null = null;
let openCount = 0;
const timings: HarnessTiming[] = [];
/** The rendered host note on the pane, when a host is loaded instead of a map view. */
let host: { note: HarnessHost; renderer: Component; sizer: HTMLElement } | null = null;

export interface HostTiming {
  host: string;
  mode: HarnessHost["mode"];
  /** Embeds the page rendered as maps / left as Obsidian's placeholders. */
  maps: number;
  plain: number;
  /** From the first post-processor call until every map had its nodes placed and stopped moving. */
  settledMs: number;
}
const hostTimings: HostTiming[] = [];

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

/** Drop the rendered host note the way Obsidian drops a view: the renderer unloads, and the embeds with it. */
function closeHost(): void {
  if (!host) return;
  const closing = host;
  host = null;
  closing.renderer.unload();
  closing.sizer.closest(".markdown-reading-view")?.remove();
}

/** Blocks of a note as Obsidian's reading view lays them out: one section element per block, headings as headings. */
async function renderNote(sizer: HTMLElement, source: string, sourcePath: string): Promise<HTMLElement[]> {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  const sections: HTMLElement[] = [];
  for (const block of body.split(/\n{2,}/u)) {
    if (!block.trim()) continue;
    const heading = block.match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/u);
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length;
      const section = sizer.createDiv({ cls: `el-h${level}` });
      section.createEl(`h${level}` as "h1", { text: heading[2] });
      sections.push(section);
      continue;
    }
    const section = sizer.createDiv({ cls: "el-p" });
    await MarkdownRenderer.render(app.asApp<App>(), block, section, sourcePath);
    sections.push(section);
  }
  return sections;
}

function contextFor(renderer: Component, sourcePath: string): MarkdownPostProcessorContext {
  return {
    docId: sourcePath, sourcePath, frontmatter: null,
    addChild: child => { renderer.addChild(child as unknown as Component); },
    getSectionInfo: () => null,
  };
}

/**
 * Show a note that embeds maps. `reading` hands the host's sections to the post processor
 * (the `![[…]]` placeholders are still spans). `live` first renders every embedded note
 * inside an Obsidian-like `.internal-embed.markdown-embed` container, as the live-preview
 * widget does, and hands those inner sections to the processor with the embedded note as
 * the source path. Neither path touches the in-memory notes.
 */
async function loadHost(note: HarnessHost): Promise<HostTiming> {
  await closeView();
  closeHost();
  current = null;
  fixtureSelect.value = note.id;
  coversEl.textContent = note.covers;
  const url = new URL(location.href);
  url.searchParams.set("fixture", note.id);
  history.replaceState(null, "", url);
  const reading = pane.createDiv({ cls: "markdown-reading-view" });
  const preview = reading.createDiv({ cls: "markdown-preview-view markdown-rendered" });
  const sizer = preview.createDiv({ cls: "markdown-preview-sizer" });
  const renderer = new Component();
  renderer.load();
  host = { note, renderer, sizer };
  const sections = await renderNote(sizer, note.source, note.path);
  const started = performance.now();
  if (note.mode === "reading") {
    for (const section of sections) embeds.process(section, contextFor(renderer, note.path));
  } else {
    for (const span of Array.from(sizer.querySelectorAll<HTMLElement>(".internal-embed"))) {
      const { path } = parseLinktext(span.getAttribute("src") ?? "");
      const file = app.metadataCache.getFirstLinkpathDest(path);
      if (!file || file.extension !== "md") continue;
      span.addClass("markdown-embed", "inline-embed", "is-loaded");
      span.empty();
      const inner = span.createDiv({ cls: "markdown-embed-content" }).createDiv({ cls: "markdown-preview-view markdown-rendered" });
      for (const section of await renderNote(inner, app.content(file), file.path)) embeds.process(section, contextFor(renderer, file.path));
    }
  }
  await settle(4000);
  const maps = sizer.querySelectorAll(".mappy-embed").length;
  const plain = sizer.querySelectorAll(".internal-embed:not(.mappy-embed-host)").length;
  const timing: HostTiming = { host: note.id, mode: note.mode, maps, plain, settledMs: performance.now() - started };
  hostTimings.push(timing);
  openCount += 1;
  setStatus(`${note.label}: 埋め込み ${maps + plain}（マップ ${maps}、通常の埋め込み ${plain}）、安定まで ${timing.settledMs.toFixed(0)} ms、表示 ${openCount} 回目`);
  return timing;
}

async function openView(): Promise<MindmapView> {
  closeHost();
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
async function load(id: string, mode?: LayoutMode): Promise<HarnessTiming | HostTiming> {
  const embedHost = findHost(id);
  if (embedHost) return loadHost(embedHost);
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

async function reopen(): Promise<HarnessTiming | HostTiming | null> {
  if (host) {
    const note = host.note;
    closeHost();
    return loadHost(note);
  }
  const fixture = current;
  await closeView();
  view = await openView();
  return fixture ? load(fixture.id) : null;
}

/** The page's stand-in for Obsidian's theme: only the placeholder variables change (docs/harness.md, 対象外: テーマ). */
function setTheme(dark: boolean): void {
  document.body.toggleClass("theme-dark", dark);
  document.body.toggleClass("theme-light", !dark);
  themeInput.checked = dark;
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
    if (findHost(id)) throw new Error(`${id} は埋め込みのホストノートで、性能計測の対象は map view の fixture だけです`);
    await closeView();
    view = await openView();
    return load(id, mode) as Promise<LoadSample>;
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

interface EmbedInfo {
  /** `data-mappy-embed` of a map, or the placeholder's `src`. */
  src: string;
  kind: "map" | "plain";
  rect: PlainRect;
  nodes: ReturnType<typeof nodeInfo>[];
  /** The sentence shown instead of a map, if any. */
  message: string | null;
  layout: "mindmap" | "timeline" | "hierarchy" | null;
  /** `scale(…)` of the fitted map, when placed. */
  scale: number | null;
}

/** Every embed on the rendered host note in document order, maps and Obsidian's placeholders alike. */
function embedInfo(element: HTMLElement): EmbedInfo {
  const map = element.hasClass("mappy-embed");
  const node = element.querySelector<HTMLElement>(".mappy-node");
  const scale = element.querySelector<HTMLElement>(".mappy-world")?.style.transform.match(/scale\(([\d.]+)\)/u)?.[1];
  const message = element.querySelector<HTMLElement>(".mappy-embed-message");
  return {
    src: element.dataset.mappyEmbed ?? element.getAttribute("src") ?? "",
    kind: map ? "map" : "plain",
    rect: plainRect(element) ?? { x: 0, y: 0, width: 0, height: 0 },
    nodes: Array.from(element.querySelectorAll<HTMLElement>(".mappy-node"), nodeInfo),
    message: message && !message.hidden ? message.textContent : null,
    layout: node ? (node.hasClass("is-timeline") ? "timeline" : node.hasClass("is-hierarchy") ? "hierarchy" : "mindmap") : null,
    scale: scale ? Number(scale) : null,
  };
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
  hosts: EMBED_HOSTS.map(note => note.id),
  timings,
  hostTimings,
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
  /** Note embeds on the rendered host note (maps and Obsidian's placeholders) in document order; images and anything inside a map are not embeds of the host. */
  embeds: () => Array.from(pane.querySelectorAll<HTMLElement>(".mappy-embed, .internal-embed:not(.mappy-embed-host):not(.image-embed)"))
    .filter(element => !element.parentElement?.closest(element.hasClass("mappy-embed") ? ".mappy-embed" : ".mappy-embed, .mappy-embed-host"))
    .map(embedInfo),
  /** Live map embeds the post processor still owns. */
  liveEmbeds: () => embeds.size,
  /** What the plugin does on unload: every map goes back to Obsidian's placeholder. */
  disposeEmbeds: () => { embeds.dispose(); },
  /** The note a path holds now, as the in-memory vault has it. */
  noteSource: (path: string) => { const file = app.vault.getAbstractFileByPath(path); return file ? app.content(file) : null; },
  /** Replace a note in the in-memory vault; open maps and embeds observe it like an external edit. */
  putNote: (path: string, content: string) => { app.put(path, content); },
  setTheme,
  scrollTo: (top: number) => { const reading = pane.querySelector<HTMLElement>(".markdown-reading-view"); if (reading) reading.scrollTop = top; },
  /** Scroll the rendered host so the embed with this `data-mappy-embed` / `src` sits at the top of the pane. */
  revealEmbed: (src: string) => {
    const element = Array.from(pane.querySelectorAll<HTMLElement>(".mappy-embed, .internal-embed"))
      .find(candidate => (candidate.dataset.mappyEmbed ?? candidate.getAttribute("src")) === src);
    element?.scrollIntoView({ block: "start" });
  },
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
  const hostGroup = fixtureSelect.createEl("optgroup", { attr: { label: "埋め込み（ホストノート）" } });
  for (const note of EMBED_HOSTS) hostGroup.createEl("option", { value: note.id, text: note.label });
  themeInput.addEventListener("change", () => { setTheme(themeInput.checked); });
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
setTheme(params.get("theme") === "dark");
resize(Number(params.get("width")) || 1280, Number(params.get("height")) || 800);
api.ready = load(findHost(params.get("fixture"))?.id ?? findFixture(params.get("fixture"))?.id ?? "uneven-branches").then(() => undefined);
report(api.ready);
