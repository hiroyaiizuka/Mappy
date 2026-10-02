import { FuzzySuggestModal, Notice, setIcon, type App, type TFile } from "obsidian";
import type { AiFailure, AiMaterial, AiProgress, AiRequest, AiResult, AiRunner, AiTemplate, OutlineItem } from "../../ai/contract";
import { nodeBody } from "../../core/body";
import type { MindDocument, MindNode } from "../../core/markdown";
import { fitBranches } from "../../core/new-branches";
import { findNode } from "../../core/text-edits";
import type { Viewport } from "../../interaction/viewport";
import { AI_DRAFT_PREFIX, withDraft } from "../../layout/ai-draft";
import type { LayoutMode, LayoutNode, LayoutResult, PositionedNode } from "../../layout/layout";
import { t, type Messages } from "../../i18n";
import { aiRunLock, type AiServices } from "./services";
import { AI_TEMPLATES, ancestorTitles, maxDepth, nodeMaterial, outlineMarkdown } from "./request";

/** Whether `add-children` wrote (the view's `execute`, §11.5), or why it did not: then the draft stays. */
export type KeepOutcome = { written: true } | { written: false; reason: string };

/** What the AI needs from the map view it lives in; the view answers from its own state (src/ui/mindmap-view.ts). */
export interface AiHost {
  readonly app: App;
  /** Where the card goes (screen-positioned over the canvas) and where the button and the draft's nodes go (the world). */
  readonly pane: HTMLElement;
  readonly world: HTMLElement;
  document(): MindDocument | undefined;
  file(): TFile | null;
  selectedId(): string | null;
  /** A node of a called map, or the item calling it (§5 M12): read-only for the AI. */
  readOnly(id: string): boolean;
  mode(): LayoutMode;
  viewport(): Viewport;
  /** `add-children` through the view's `execute`, one write (§11.5). */
  keep(nodeId: string, items: readonly OutlineItem[]): Promise<KeepOutcome>;
  /** Open the folds over `id` and `id` itself, so the draft under it shows. */
  expand(id: string): void;
  /** Ask for a layout frame. */
  layout(): void;
}

interface Draft {
  anchorId: string;
  items: OutlineItem[];
  /** The layout id of each item, in preorder (`ai-draft:<generation>-<n>`). */
  ids: Map<OutlineItem, string>;
  values: FormValues;
  dropped: number;
}

/** What the input holds: kept for やり直す, which runs it again. */
interface FormValues {
  instruction: string;
  template: AiTemplate;
  depth: 1 | 2 | 3;
  engine: "claude" | "codex" | "fake";
  webSearch: boolean;
  attachments: TFile[];
}

interface Run { anchorId: string; values: FormValues; abort: AbortController; progress: AiProgress | null }

/** The line under the card's content: a refusal or failure (with what to show under 詳細), a keep that did not write. */
interface Message { text: string; detail?: string; copy?: boolean }

const FAILURE_TEXT: Record<AiFailure, (text: Messages) => string> = {
  "engine-missing": text => text.aiFailureEngineMissing,
  "ytdlp-missing": text => text.aiFailureYtDlpMissing,
  "unsupported-platform": text => text.aiFailureUnsupportedPlatform,
  "not-logged-in": text => text.aiFailureNotLoggedIn,
  "no-subtitles": text => text.aiFailureNoSubtitles,
  "no-pdf-text": text => text.aiFailureNoPdfText,
  "material-too-large": text => text.aiFailureMaterialTooLarge,
  "material-failed": text => text.aiFailureMaterialFailed,
  timeout: text => text.aiFailureTimeout,
  "output-too-large": text => text.aiFailureOutputTooLarge,
  unparsable: text => text.aiFailureUnparsable,
  exited: text => text.aiFailureExited,
};

function templateLabel(template: AiTemplate): string {
  const text = t();
  switch (template) {
    case "summary": return text.aiTemplateSummary;
    case "brainstorm": return text.aiTemplateBrainstorm;
    case "issue-tree": return text.aiTemplateIssueTree;
    case "free": return text.aiTemplateFree;
  }
}

function progressLabel(progress: AiProgress | null): string {
  const text = t();
  switch (progress?.stage) {
    case "material": return text.aiStageMaterial(progress.label);
    case "searching": return text.aiStageSearching(progress.query);
    case "fetching": return text.aiStageFetching(progress.url);
    case "thinking": return text.aiStageThinking;
    case "writing": return text.aiStageWriting;
    case "starting": case undefined: return text.aiStageStarting;
  }
}

/** The Vault's notes and PDFs, for the input's attachment (§11.2); the note the map shows is left out. */
class AttachModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly except: TFile | null, private readonly choose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder(t().aiAttachPlaceholder);
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles()
      .filter(file => (file.extension === "md" || file.extension === "pdf") && file.path !== this.except?.path)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  getItemText(file: TFile): string { return file.path; }

  onChooseItem(file: TFile): void { this.choose(file); }
}

/**
 * The button is a badge on the selected node's top-right corner, its centre on the corner (`placeButton`): right of the
 * node is where the map draws the fold control and the connectors. The gap between what the card hangs under and the
 * card, and the card's margin in the pane, in pixels.
 */
/** Below this zoom the AI button keeps its size on screen (`placeButton`): 22px × 0.64 ≈ 14px. */
const BUTTON_MIN_ZOOM = 0.64;
const CARD_GAP = 10;
const CARD_MARGIN = 8;

/**
 * The map's AI, 案 A (docs/architecture.md §11.5, LEV-271): the AI button beside the selected node, the input card
 * that opens from it, the run's progress and 取り消す, and the result as a draft of dotted nodes under the node with
 * 残す／やり直す／捨てる. One per map view. The draft lives here only — never in the note or `localStorage` — and goes
 * with the view, the note or the view's `reset`; 残す writes it through the view (`AiHost.keep`), one step of the
 * history. The view lays the draft's nodes out with its own (`layoutTrees`, `sizes`) and hands the frame back
 * (`place`). Without services (no license gate wired, a view of the browser page set up without them) nothing shows.
 */
export class AiController {
  private services: AiServices | null = null;
  private releaseServices: (() => void) | undefined;
  private readonly releaseLock: () => void;
  private readonly button: HTMLButtonElement;
  private readonly card: HTMLDivElement;
  private form: { anchorId: string; values: FormValues; message: string | null } | null = null;
  private run: Run | null = null;
  private draft: Draft | null = null;
  /** The last run's values that did not end in a draft (a refusal, a failure): what やり直す runs again. */
  private failed: { anchorId: string; values: FormValues; message: Message } | null = null;
  private message: Message | null = null;
  private keeping = false;
  private detailOpen = false;
  private generation = 0;
  private readonly draftElements = new Map<string, HTMLDivElement>();
  private lastLayout: LayoutResult | undefined;
  private opening = false;
  /** Where the node the button is on was laid out. */
  private buttonFor: PositionedNode | undefined;

  constructor(private readonly host: AiHost) {
    this.button = host.world.createEl("button", { cls: "mappy-ai-button", attr: { type: "button", "aria-label": t().aiButton } });
    setIcon(this.button, "sparkles");
    this.button.hidden = true;
    // A press here is not the canvas's: no pan, no deselection, no drag.
    this.button.addEventListener("pointerdown", event => { event.stopPropagation(); });
    this.button.addEventListener("dblclick", event => { event.stopPropagation(); });
    this.button.addEventListener("click", event => {
      event.stopPropagation();
      void this.openInput();
    });
    this.card = host.pane.createDiv({ cls: "mappy-ai-card mappy-floating", attr: { role: "dialog", "aria-label": t().aiPanelLabel } });
    this.card.hidden = true;
    this.card.addEventListener("keydown", event => { this.cardKey(event); });
    this.releaseLock = aiRunLock.onChange(() => { this.sync(); });
  }

  /** The plugin's services (src/main.ts), or none: then no AI shows, and whatever was under way goes. */
  setServices(services: AiServices | null): void {
    if (this.services === services) return;
    this.releaseServices?.();
    this.releaseServices = undefined;
    this.services = services;
    if (!services) this.reset();
    else this.releaseServices = services.onChange(() => { this.sync(); });
    this.sync();
  }

  /** Whether a draft is on the map: the export waits for it to be kept or discarded. */
  hasDraft(): boolean { return this.draft !== null; }

  /** Whether a run is under way in this view. */
  running(): boolean { return this.run !== null; }

  /** Everything goes without a word: the view closes, the note leaves it, the page goes (§11.5). A run is cancelled. */
  reset(): void {
    this.run?.abort.abort();
    this.run = null;
    this.form = null;
    this.failed = null;
    this.message = null;
    this.setDraft(null);
    this.sync();
  }

  dispose(): void {
    this.reset();
    this.releaseServices?.();
    this.releaseLock();
    this.button.remove();
    this.card.remove();
  }

  /**
   * The note was read again (an external change, a write of the map's own). A draft stays with its node while the
   * node's id carries over (§3); once the node is gone, the draft closes with a Notice that can copy the result, so
   * the run's result is not dropped without a word. An input open on a node that is gone closes.
   */
  documentChanged(document: MindDocument): void {
    if (this.draft && !findNode(document, this.draft.anchorId)) {
      const draft = this.draft;
      this.setDraft(null);
      this.message = null;
      this.lostNotice(draft.items);
    }
    if (this.form && !findNode(document, this.form.anchorId)) this.form = null;
    this.sync();
  }

  /** The trees laid out with the draft under its node (§11.5), or null without a draft or when its node is not shown. */
  layoutTrees(trees: readonly LayoutNode[], collapsed: ReadonlySet<string>): { trees: LayoutNode[]; collapsed: ReadonlySet<string> } | null {
    const draft = this.draft;
    if (!draft) return null;
    const nodes = this.draftNodes(draft);
    for (let index = trees.length - 1; index >= 0; index -= 1) {
      const tree = trees[index];
      const rebuilt = tree ? withDraft(tree, draft.anchorId, nodes, collapsed) : null;
      if (!rebuilt) continue;
      const next = [...trees];
      next[index] = rebuilt;
      // A collapsed anchor shows the draft alone (`withDraft`), so it is not laid out as collapsed.
      return { trees: next, collapsed: collapsed.has(draft.anchorId) ? new Set(Array.from(collapsed).filter(id => id !== draft.anchorId)) : collapsed };
    }
    return null;
  }

  /** The draft's node sizes, added to the map's. */
  sizes(sizes: Map<string, { width: number; height: number }>): void {
    for (const [id, element] of this.draftElements) sizes.set(id, { width: element.offsetWidth, height: element.offsetHeight });
  }

  /** The frame the view laid out: the draft's nodes, the button and the card go where it put the nodes. */
  place(layout: LayoutResult): void {
    this.lastLayout = layout;
    const mode = this.host.mode();
    for (const node of layout.nodes) {
      const element = this.draftElements.get(node.id);
      if (!element) continue;
      element.style.transform = `translate(${node.x}px, ${node.y}px)`;
      // The layout's classes, as NodeRenderer gives the map's own nodes: they set the box the layout measures.
      element.toggleClass("is-timeline", mode === "timeline");
      element.toggleClass("is-hierarchy", mode === "hierarchy");
      element.toggleClass("is-balanced", mode === "balanced");
    }
    this.sync();
  }

  /** The view panned or zoomed: the card follows its node on screen. */
  reposition(): void {
    this.placeButton();
    this.placeCard();
  }

  /**
   * The badge's centre on the node's top-right corner. It follows the zoom like the map down to BUTTON_MIN_ZOOM and keeps
   * that size on screen below it, so it stays a target to press: at 100% the vertical gap between siblings (at least
   * 14px) is wider than half of it, while on a map zoomed far out it can reach over the corner of the node above.
   */
  private placeButton(): void {
    const placed = this.buttonFor;
    if (this.button.hidden || !placed) return;
    const scale = this.host.viewport().scale || 1;
    const size = Math.min(1, Math.max(BUTTON_MIN_ZOOM, scale)) / scale;
    this.button.style.transform = `translate(${placed.x + placed.width}px, ${placed.y}px) scale(${size}) translate(-50%, -50%)`;
  }

  /** Whether the button shows on `node`, and why not; also what opening the input checks. */
  private eligible(document: MindDocument, node: MindNode): "yes" | "virtual-root" | "no" {
    if (this.host.readOnly(node.id)) return "no";
    if (node.kind === "root") return "virtual-root";
    return maxDepth(document, node) > 0 ? "yes" : "no";
  }

  /** The button's state for the selection, the license and the lock; the card's content for the phase. */
  sync(): void {
    const document = this.host.document();
    const id = this.host.selectedId();
    const node = document && id !== null ? findNode(document, id) : undefined;
    const kind = this.services?.state().kind;
    const shown = kind === "active" || kind === "expired" || kind === "unreachable";
    const quiet = this.form === null && this.run === null && this.draft === null && this.failed === null;
    const eligible = document && node ? this.eligible(document, node) : "no";
    const placed = node ? this.lastLayout?.nodes.find(item => item.id === node.id) : undefined;
    this.button.hidden = !shown || !quiet || eligible === "no" || !placed;
    if (!this.button.hidden && placed) {
      const busy = aiRunLock.busy(this);
      const virtual = eligible === "virtual-root";
      const label = virtual ? t().aiAddH2First : busy ? t().aiBusy : t().aiButton;
      this.button.toggleClass("is-disabled", busy || virtual);
      this.button.setAttribute("aria-disabled", String(busy || virtual));
      this.button.setAttribute("aria-label", label);
    }
    this.buttonFor = this.button.hidden ? undefined : placed;
    this.placeButton();
    this.renderCard();
  }

  /**
   * The button pressed: the input opens on the selected node. Expired or unreachable, the license is refreshed first
   * and the input opens once it is active (§11.6); the virtual root says to add an H2 first (§11.5).
   */
  async openInput(): Promise<void> {
    const services = this.services;
    const document = this.host.document();
    const id = this.host.selectedId();
    const node = document && id !== null ? findNode(document, id) : undefined;
    if (!services || !document || !node || this.opening) return;
    const eligible = this.eligible(document, node);
    if (eligible === "virtual-root") { new Notice(t().aiAddH2First); return; }
    if (eligible === "no" || this.run || this.draft) return;
    if (aiRunLock.busy(this)) { new Notice(t().aiBusy); return; }
    let state = services.state();
    if (state.kind === "expired" || state.kind === "unreachable") {
      this.opening = true;
      try { state = await services.refresh(); } finally { this.opening = false; }
    }
    if (state.kind !== "active") {
      if (state.reason) new Notice(t().aiUnavailable(state.reason));
      this.sync();
      return;
    }
    // The note or the selection may have moved on while the license was refreshed.
    const current = this.host.document();
    if (!current || !findNode(current, node.id)) return;
    this.failed = null;
    this.message = null;
    this.form = { anchorId: node.id, values: this.defaults(current, node), message: null };
    this.sync();
    this.card.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
  }

  /** The input's starting values (§5 M9): a node pointing at a video, a PDF or a page asks for its summary. */
  private defaults(document: MindDocument, node: MindNode): FormValues {
    const text = t();
    const material = nodeMaterial(document, node);
    const depth = Math.min(2, maxDepth(document, node)) as 1 | 2;
    const base = { depth, engine: this.services?.defaultEngine() ?? "claude", attachments: [] } as const;
    switch (material) {
      case "youtube": return { ...base, attachments: [], template: "summary", instruction: text.aiDefaultSummaryVideo, webSearch: false };
      case "pdf": return { ...base, attachments: [], template: "summary", instruction: text.aiDefaultSummaryPdf, webSearch: false };
      // Mappy does not fetch a web page itself: the CLI does, with the web search on (§11.2).
      case "url": return { ...base, attachments: [], template: "summary", instruction: text.aiDefaultSummaryLink, webSearch: true };
      case null: return { ...base, attachments: [], template: "brainstorm", instruction: "", webSearch: false };
    }
  }

  private cardKey(event: KeyboardEvent): void {
    // Nothing on the card is the map's: its keys stay here.
    event.stopPropagation();
    // A key the IME is composing with is the IME's (E01): ⌘↵ confirms the reading, not the run.
    if (event.isComposing || event.key === "Process") return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.form) { this.form = null; this.sync(); }
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && this.form) {
      event.preventDefault();
      this.submit();
    }
  }

  /** 実行: the input's values as a run on its node. */
  private submit(): void {
    const form = this.form;
    if (!form) return;
    this.readForm(form.values);
    if (form.values.template === "free" && form.values.instruction.trim() === "") {
      form.message = t().aiInstructionNeeded;
      this.renderCard();
      return;
    }
    this.form = null;
    void this.start(form.anchorId, form.values);
  }

  /** The values on the card's controls, into `values`. */
  private readForm(values: FormValues): void {
    const field = <T extends HTMLElement>(name: string): T | null => this.card.querySelector<T>(`[data-ai-field="${name}"]`);
    values.instruction = field<HTMLTextAreaElement>("instruction")?.value ?? values.instruction;
    const template = field<HTMLSelectElement>("template")?.value;
    if (template && (AI_TEMPLATES as readonly string[]).includes(template)) values.template = template as AiTemplate;
    const depth = Number(field<HTMLSelectElement>("depth")?.value);
    if (depth === 1 || depth === 2 || depth === 3) values.depth = depth;
    const engine = field<HTMLSelectElement>("engine")?.value;
    if (engine === "claude" || engine === "codex" || (engine === "fake" && this.services?.fakeRunner)) values.engine = engine;
    values.webSearch = field<HTMLInputElement>("web-search")?.checked ?? values.webSearch;
  }

  /**
   * One run (§11.3: one at a time in the whole of Mappy, no retry of its own). The result replaces the draft when it
   * is an outline; a refusal, a failure or a cancel leaves the draft there was (やり直す keeps it until a run succeeds).
   */
  private async start(anchorId: string, values: FormValues): Promise<void> {
    const services = this.services;
    const document = this.host.document();
    const node = document ? findNode(document, anchorId) : undefined;
    if (!services || !document || !node) return;
    const runner: AiRunner | null = values.engine === "fake" ? services.fakeRunner ?? null : services.createRunner();
    if (!runner) {
      const state = services.state();
      new Notice(t().aiUnavailable(state.reason ?? state.kind));
      this.sync();
      return;
    }
    if (!aiRunLock.take(this)) { new Notice(t().aiBusy); this.sync(); return; }
    const run: Run = { anchorId, values, abort: new AbortController(), progress: null };
    this.run = run;
    this.failed = null;
    this.message = null;
    this.sync();
    let result: AiResult;
    try {
      const materials: AiMaterial[] = [];
      for (const file of values.attachments) {
        this.progress(run, { stage: "material", label: file.basename });
        try { materials.push(await services.readAttachment(file)); }
        catch (error) { throw new MaterialError(error instanceof Error ? error.message : String(error)); }
        if (run.abort.signal.aborted) break;
      }
      const request: AiRequest = {
        engine: values.engine === "codex" ? "codex" : "claude",
        template: values.template,
        instruction: values.instruction.trim(),
        depth: Math.min(values.depth, maxDepth(document, node)) as 1 | 2 | 3,
        webSearch: values.webSearch,
        context: { ancestors: ancestorTitles(document, node), title: node.title, body: node.kind === "root" ? "" : nodeBody(document, node) },
        materials,
      };
      result = run.abort.signal.aborted ? { kind: "cancelled" }
        : await runner.run(request, progress => { this.progress(run, progress); }, run.abort.signal);
    } catch (error) {
      result = error instanceof MaterialError
        ? { kind: "failed", reason: "material-failed", detail: error.message }
        : { kind: "failed", reason: "exited", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      aiRunLock.release(this);
    }
    // Reset meanwhile (the view closed, the note left it): the result is nobody's.
    if (this.run !== run) return;
    this.run = null;
    this.settle(run, result);
    this.sync();
  }

  private progress(run: Run, progress: AiProgress): void {
    if (this.run !== run) return;
    run.progress = progress;
    this.renderCard();
  }

  private settle(run: Run, result: AiResult): void {
    const text = t();
    // 詳細 opens on the message it was pressed for, not on the next one.
    this.detailOpen = false;
    if (result.kind === "cancelled") {
      if (!this.draft) new Notice(text.aiCancelled);
      return;
    }
    if (result.kind === "refused" || result.kind === "failed") {
      const message: Message = result.kind === "refused"
        ? { text: text.aiRefused(result.reason), detail: result.raw }
        : { text: FAILURE_TEXT[result.reason](text), detail: result.detail };
      if (this.draft) this.message = message;
      else this.failed = { anchorId: run.anchorId, values: run.values, message };
      return;
    }
    const document = this.host.document();
    const node = document ? findNode(document, run.anchorId) : undefined;
    if (!document || !node) { this.lostNotice(result.items); return; }
    const items = fitBranches(result.items, maxDepth(document, node));
    if (items.length === 0) {
      const message = { text: FAILURE_TEXT.unparsable(text), detail: result.raw };
      if (this.draft) this.message = message;
      else this.failed = { anchorId: run.anchorId, values: run.values, message };
      return;
    }
    this.setDraft({ anchorId: run.anchorId, items, ids: new Map(), values: run.values, dropped: result.dropped });
    this.message = result.dropped > 0 ? { text: text.aiDropped(result.dropped) } : null;
    this.host.expand(run.anchorId);
  }

  /** The draft as the map shows it: its elements made (or removed) now, laid out on the next frame. */
  private setDraft(draft: Draft | null): void {
    for (const element of this.draftElements.values()) element.remove();
    this.draftElements.clear();
    this.draft = draft;
    this.detailOpen = false;
    if (draft) {
      this.generation += 1;
      let count = 0;
      const walk = (items: readonly OutlineItem[]): void => {
        for (const item of items) {
          const id = `${AI_DRAFT_PREFIX}${this.generation}-${++count}`;
          draft.ids.set(item, id);
          const element = this.host.world.querySelector(".mappy-nodes")?.createDiv({
            cls: "mappy-node mappy-ai-draft", attr: { "data-ai-draft": id, "aria-label": t().aiDraftNode(item.text) },
          });
          if (element) {
            element.createDiv({ cls: "mappy-node-content" }).createDiv({ cls: "mappy-node-label", text: item.text });
            this.draftElements.set(id, element);
          }
          walk(item.children);
        }
      };
      walk(draft.items);
    }
    this.host.layout();
  }

  private draftNodes(draft: Draft): LayoutNode[] {
    const nodes = (items: readonly OutlineItem[]): LayoutNode[] => items.map(item => ({ id: draft.ids.get(item) ?? "", children: nodes(item.children) }));
    return nodes(draft.items);
  }

  /** 残す: `add-children` through the view (§11.5). The draft goes only once the view says it wrote. */
  private async keep(): Promise<void> {
    const draft = this.draft;
    if (!draft || this.keeping) return;
    this.keeping = true;
    this.message = null;
    this.renderCard();
    let outcome: KeepOutcome;
    try { outcome = await this.host.keep(draft.anchorId, draft.items); }
    catch (error) {
      outcome = { written: false, reason: error instanceof Error ? error.message : String(error) };
    } finally { this.keeping = false; }
    if (this.draft !== draft) { this.sync(); return; }
    if (outcome.written) this.setDraft(null);
    else this.message = { text: t().aiKeepFailed(outcome.reason), copy: true };
    this.sync();
  }

  /** やり直す: the same input again; the draft stays until the new run succeeds. */
  private retry(): void {
    const source = this.draft ?? this.failed;
    if (!source || this.run) return;
    void this.start(source.anchorId, source.values);
  }

  /** 捨てる: the draft goes; the note is not touched. */
  private discard(): void {
    this.setDraft(null);
    this.message = null;
    this.failed = null;
    this.sync();
  }

  private copy(items: readonly OutlineItem[]): void {
    const text = t();
    navigator.clipboard.writeText(outlineMarkdown(items))
      .then(() => { new Notice(text.aiCopied); }, () => { new Notice(text.aiCopyFailed); });
  }

  /** The draft's node is gone (§11.5): a Notice that can copy the result. */
  private lostNotice(items: readonly OutlineItem[]): void {
    const text = t();
    const fragment = createFragment(frag => {
      frag.createDiv({ text: text.aiAnchorGone });
      const button = frag.createEl("button", { text: text.aiCopy, cls: "mappy-ai-notice-copy" });
      button.addEventListener("click", event => {
        event.stopPropagation();
        this.copy(items);
      });
    });
    new Notice(fragment, 0);
  }

  /** The card for the phase: the input, the run, the draft, or a failure. Hidden when there is none of them. */
  private renderCard(): void {
    const card = this.card;
    const focused = card.contains(card.doc.activeElement);
    const form = this.form;
    if (form) {
      // The input is built once per opening: typing must not be interrupted by a redraw.
      if (card.dataset.phase !== "input") this.buildInput(form.values, form.anchorId);
      const line = card.querySelector<HTMLElement>(".mappy-ai-message");
      if (line) line.setText(form.message ?? "");
    } else if (this.run) {
      this.resetCard("running");
      card.createDiv({ cls: "mappy-ai-progress", text: progressLabel(this.run.progress), attr: { role: "status", "aria-live": "polite" } });
      const actions = card.createDiv({ cls: "mappy-ai-actions" });
      this.action(actions, t().aiCancel, () => { this.run?.abort.abort(); });
      if (this.draft) card.createDiv({ cls: "mappy-ai-note", text: t().aiDraftCount(this.count(this.draft.items)) });
    } else if (this.draft) {
      this.resetCard("draft");
      card.createDiv({ cls: "mappy-ai-title", text: t().aiDraftCount(this.count(this.draft.items)) });
      this.messageLine(this.message, this.draft.items);
      const actions = card.createDiv({ cls: "mappy-ai-actions" });
      this.action(actions, t().aiKeep, () => { void this.keep(); }, "mod-cta", this.keeping);
      this.action(actions, t().aiRetry, () => { this.retry(); }, "", this.keeping);
      this.action(actions, t().aiDiscard, () => { this.discard(); }, "", this.keeping);
    } else if (this.failed) {
      this.resetCard("failed");
      this.messageLine(this.failed.message);
      const actions = card.createDiv({ cls: "mappy-ai-actions" });
      this.action(actions, t().aiRetry, () => { this.retry(); }, "mod-cta");
      this.action(actions, t().aiClose, () => { this.failed = null; this.sync(); });
    } else {
      card.dataset.phase = "";
      card.empty();
      card.hidden = true;
      return;
    }
    card.hidden = false;
    this.placeCard();
    // A redraw under the focus (a button replaced) keeps the keys on the card.
    if (focused && !card.contains(card.doc.activeElement)) card.querySelector<HTMLElement>("button:not([disabled]), textarea")?.focus({ preventScroll: true });
  }

  private resetCard(phase: string): void {
    this.card.empty();
    this.card.dataset.phase = phase;
  }

  private count(items: readonly OutlineItem[]): number {
    return items.reduce((total, item) => total + 1 + this.count(item.children), 0);
  }

  private action(parent: HTMLElement, label: string, run: () => void, cls = "", disabled = false): HTMLButtonElement {
    const button = parent.createEl("button", { text: label, cls, attr: { type: "button" } });
    button.disabled = disabled;
    button.addEventListener("click", event => { event.stopPropagation(); run(); });
    return button;
  }

  /** A failure, a refusal or a keep that did not write; 詳細 shows the raw output, and a refused keep can copy the result. */
  private messageLine(message: Message | null, items?: readonly OutlineItem[]): void {
    if (!message) return;
    const line = this.card.createDiv({ cls: "mappy-ai-message", text: message.text, attr: { role: "alert" } });
    if (message.detail !== undefined && message.detail !== "") {
      const toggle = this.action(line, t().aiDetails, () => { this.detailOpen = !this.detailOpen; this.renderCard(); }, "mappy-ai-details");
      toggle.setAttribute("aria-expanded", String(this.detailOpen));
      if (this.detailOpen) this.card.createEl("pre", { cls: "mappy-ai-raw", text: message.detail });
    }
    if (message.copy && items) this.action(line, t().aiCopy, () => { this.copy(items); }, "mappy-ai-copy");
  }

  private buildInput(values: FormValues, anchorId: string): void {
    const text = t();
    const document = this.host.document();
    const node = document ? findNode(document, anchorId) : undefined;
    const limit = document && node ? maxDepth(document, node) : 3;
    this.resetCard("input");
    const card = this.card;
    const instruction = card.createEl("textarea", {
      cls: "mappy-ai-instruction",
      attr: { "data-ai-field": "instruction", rows: "3", placeholder: text.aiInstructionPlaceholder, "aria-label": text.aiInstruction },
    });
    instruction.value = values.instruction;
    const options = card.createDiv({ cls: "mappy-ai-options" });
    const select = (name: string, label: string, entries: readonly [string, string][], value: string): HTMLSelectElement => {
      const wrap = options.createEl("label", { cls: "mappy-ai-option" });
      wrap.createSpan({ text: label });
      const element = wrap.createEl("select", { cls: "dropdown", attr: { "data-ai-field": name } });
      for (const [key, title] of entries) element.createEl("option", { text: title, value: key });
      element.value = value;
      return element;
    };
    select("template", text.aiTemplate, AI_TEMPLATES.map(template => [template, templateLabel(template)]), values.template);
    select("depth", text.aiDepth, ([1, 2, 3] as const).filter(depth => depth <= limit).map(depth => [String(depth), text.aiDepthLevels(depth)]),
      String(Math.min(values.depth, limit)));
    const engines: [string, string][] = [["claude", text.aiEngineClaude], ["codex", text.aiEngineCodex]];
    if (this.services?.fakeRunner) engines.push(["fake", text.aiEngineFake]);
    select("engine", text.aiEngine, engines, values.engine);
    const web = options.createEl("label", { cls: "mappy-ai-option mappy-ai-check" });
    const box = web.createEl("input", { attr: { type: "checkbox", "data-ai-field": "web-search" } });
    box.checked = values.webSearch;
    web.createSpan({ text: text.aiWebSearch });
    const attachments = card.createDiv({ cls: "mappy-ai-attachments" });
    const drawAttachments = (): void => {
      attachments.empty();
      for (const file of values.attachments) {
        const chip = attachments.createSpan({ cls: "mappy-ai-attachment", text: file.basename });
        const remove = chip.createEl("button", { cls: "mappy-ai-attachment-remove", attr: { type: "button", "aria-label": text.aiRemoveAttachment(file.basename) } });
        setIcon(remove, "x");
        remove.addEventListener("click", event => {
          event.stopPropagation();
          values.attachments = values.attachments.filter(item => item !== file);
          drawAttachments();
        });
      }
      const add = attachments.createEl("button", { cls: "mappy-ai-attach", attr: { type: "button" } });
      setIcon(add.createSpan(), "paperclip");
      add.createSpan({ text: text.aiAttach });
      add.addEventListener("click", event => {
        event.stopPropagation();
        this.readForm(values);
        new AttachModal(this.host.app, this.host.file(), file => {
          if (!values.attachments.includes(file)) values.attachments = [...values.attachments, file];
          drawAttachments();
        }).open();
      });
    };
    drawAttachments();
    card.createDiv({ cls: "mappy-ai-message", attr: { role: "alert" } });
    const footer = card.createDiv({ cls: "mappy-ai-actions" });
    footer.createSpan({ cls: "mappy-ai-keys", text: text.aiRunKeys });
    this.action(footer, text.aiRun, () => { this.submit(); }, "mod-cta");
    this.action(footer, text.aiClose, () => { this.form = null; this.sync(); });
  }

  /**
   * Under the node the card is about, or under the draft's lowest node, kept inside the pane: on screen, so it stays
   * readable at any zoom, and moved with every frame and pan.
   */
  private placeCard(): void {
    if (this.card.hidden) return;
    const anchorId = this.form?.anchorId ?? this.run?.anchorId ?? this.draft?.anchorId ?? this.failed?.anchorId;
    const layout = this.lastLayout;
    const anchor = anchorId === undefined ? undefined : layout?.nodes.find(node => node.id === anchorId);
    if (!anchor || !layout) return;
    const draftIds = new Set(this.draftElements.keys());
    const covered: PositionedNode[] = [anchor, ...layout.nodes.filter(node => draftIds.has(node.id))];
    const view = this.host.viewport();
    const left = Math.min(...covered.map(node => node.x)) * view.scale + view.x;
    const bottom = Math.max(...covered.map(node => node.y + node.height)) * view.scale + view.y + CARD_GAP;
    const pane = this.host.pane;
    const width = this.card.offsetWidth;
    const height = this.card.offsetHeight;
    const x = Math.max(CARD_MARGIN, Math.min(left, pane.clientWidth - width - CARD_MARGIN));
    const y = Math.max(CARD_MARGIN, Math.min(bottom, pane.clientHeight - height - CARD_MARGIN));
    this.card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

/** A material that could not be read: the run ends as `material-failed` with this reason. */
class MaterialError extends Error {}
