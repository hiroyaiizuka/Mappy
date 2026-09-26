import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import type { MindDocument, MindNode } from "../core/markdown";
import { nodeBody } from "../core/body";
import { displayTitle } from "../core/title-breaks";
import { attachmentMarkdown, transclusionsAsLinks } from "../core/attachments";
import type { CallSource } from "../core/calls";
import { foldBadgeWidth, foldControlSize, type FoldPosition, type LayoutMode, type PositionedNode } from "../layout/layout";

interface NodeEntry {
  element: HTMLDivElement;
  content: HTMLDivElement;
  toggle: HTMLButtonElement;
  toggleMark: HTMLSpanElement;
  /** What a screen reader reads for the node (`aria-labelledby`) and after it (`aria-describedby`); see `nameElement`. */
  name: HTMLSpanElement;
  /** Made the first time the node is drawn from a called map: most nodes never are. */
  description: HTMLSpanElement | null;
  component: Component;
  key: string;
  /** Whether the inline editor stands in for this node's text; see `editing()`. */
  editing: boolean;
}

interface NodeAppearance {
  visualRootId: string;
  /** Free topics are roots of their own trees: dark face, framed first level. */
  topicIds?: ReadonlySet<string>;
  mode: LayoutMode;
  /**
   * Nodes drawn from a called map (§5 M12), by id: their text, body and links are read from the
   * called note (`source.document`, `source.node`, `source.path`), not from `document`.
   */
  sources?: ReadonlyMap<string, CallSource>;
  /** The trees on the map (the body root and the free topics), for the fold counts; `document.root` when absent. */
  trees?: readonly MindNode[];
}

/** Ids of the hidden name elements; a counter, since two views (or an embed) of one note draw the same node ids. */
let nameIds = 0;

/**
 * A hidden element holding what a screen reader reads, pointed at by `aria-labelledby`/`aria-describedby`. Not an
 * `aria-label` or `title` on the node: Obsidian's desktop app draws an `aria-label` as a tooltip on hover (and the
 * browser a `title`), which repeats the text on screen over the node below — the input of the node being written
 * there (LEV-199). A reference reaches a hidden element all the same (accessible name computation, step 2B).
 */
function nameElement(parent: HTMLElement, role: string): HTMLSpanElement {
  const element = parent.createSpan({ cls: `mappy-node-${role}`, attr: { id: `mappy-node-${role}-${++nameIds}` } });
  element.hidden = true;
  return element;
}

/** Each Markdown render owns a disposable child component. */
export class NodeRenderer extends Component {
  readonly entries = new Map<string, NodeEntry>();
  private selectedId: string | null = null;
  /**
   * The Markdown renders still in flight for what the map shows, by node id: the settling of both renders of the
   * entry (the value tells one render from the next). A render only reports its end by asking for another layout
   * frame, which the export (§5 M13) cannot wait for; this is what `idle()` waits on. A re-render or a removal
   * supersedes the old render, whose late result no shown element receives.
   */
  private readonly rendering = new Map<string, Promise<unknown>>();
  /** Renders finished so far: a wait that sees this move is slow, not stalled. */
  private finished = 0;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly app: App,
    private readonly layer: HTMLElement,
    private readonly changed: () => void,
  ) { super(); }

  update(
    nodes: MindNode[],
    document: MindDocument,
    sourcePath: string,
    collapsed: ReadonlySet<string>,
    appearance: NodeAppearance,
  ): void {
    const descendantCounts = countDescendants(appearance.trees ?? [document.root]);
    const retained = new Set(nodes.map(node => node.id));
    let dropped = false;
    for (const [id, entry] of this.entries) {
      if (retained.has(id) || entry.element.hasClass("is-editing")) continue;
      this.removeChild(entry.component);
      entry.element.remove();
      this.entries.delete(id);
      dropped = this.rendering.delete(id) || dropped;
    }
    for (const node of nodes) {
      let entry = this.entries.get(node.id);
      if (!entry) {
        const element = this.layer.createDiv({ cls: "mappy-node", attr: {
          "data-node-id": node.id, role: "treeitem", tabindex: "-1", "aria-selected": "false",
        } });
        const content = element.createDiv({ cls: "mappy-node-content" });
        const toggle = element.createEl("button", { cls: "mappy-node-toggle", attr: { tabindex: "0", type: "button" } });
        const toggleMark = toggle.createSpan({ cls: "mappy-node-toggle-mark", attr: { "aria-hidden": "true" } });
        const name = nameElement(element, "name");
        element.setAttribute("aria-labelledby", name.id);
        entry = { element, content, toggle, toggleMark, name, description: null, component: this.addChild(new Component()), key: "", editing: false };
        this.entries.set(node.id, entry);
      }
      const isCollapsed = collapsed.has(node.id) && node.children.length > 0;
      const isTopic = appearance.topicIds?.has(node.id) ?? false;
      const isRoot = isTopic || node.id === appearance.visualRootId;
      const parentIsRoot = node.parentId === appearance.visualRootId || (node.parentId !== null && (appearance.topicIds?.has(node.parentId) ?? false));
      // A node of a called map (§5 M12) reads its text and body from the called note. The calling item stands in for
      // that map's root: its text is the called root's, its attachments are its own item's (what this map edits).
      const source = appearance.sources?.get(node.id);
      const path = source?.path ?? sourcePath;
      const bodyPath = source && !source.root ? source.path : sourcePath;
      entry.element.toggleClass("is-root", isRoot);
      entry.element.toggleClass("is-topic", isTopic);
      entry.element.toggleClass("is-stage", !isRoot && parentIsRoot);
      entry.element.toggleClass("is-parent", node.children.length > 0);
      entry.element.toggleClass("is-called", source !== undefined);
      entry.element.toggleClass("is-called-root", source?.root ?? false);
      entry.element.toggleClass("is-timeline", appearance.mode === "timeline");
      entry.element.toggleClass("is-hierarchy", appearance.mode === "hierarchy");
      entry.element.toggleClass("is-balanced", appearance.mode === "balanced");
      entry.element.toggleClass("is-collapsed", isCollapsed);
      entry.element.setAttribute("aria-level", String(Math.max(1, node.level)));
      // Written only when it changes: a text node replaced on every refresh of a large map is a mutation each.
      // A `<br>` in the title is a break on screen and a space when read out (LEV-202).
      const name = displayTitle(node.title).replace(/\s*\n\s*/gu, " ").trim() || "空のノード";
      if (entry.name.textContent !== name) entry.name.setText(name);
      // The branches of a called map are read-only on this map (the calling item itself is not); every node of them
      // names its note after its name. Not on hover: a tooltip there covers the node below as the name's did (LEV-199).
      if (source && !source.root) entry.element.setAttribute("aria-readonly", "true");
      else entry.element.removeAttribute("aria-readonly");
      if (source) {
        entry.description ??= nameElement(entry.element, "description");
        const description = `呼び出し元: ${source.path}${source.subpath}`;
        if (entry.description.textContent !== description) entry.description.setText(description);
        if (entry.element.getAttribute("aria-describedby") !== entry.description.id) entry.element.setAttribute("aria-describedby", entry.description.id);
      } else if (entry.description?.textContent) {
        entry.description.setText("");
        entry.element.removeAttribute("aria-describedby");
      }
      entry.toggle.hidden = node.children.length === 0;
      entry.toggleMark.empty();
      const hiddenCount = descendantCounts.get(node.id) ?? 0;
      const badgeCount = isCollapsed ? hiddenCount : 0;
      const controlSize = foldControlSize(badgeCount);
      entry.toggle.style.width = `${controlSize.width}px`;
      entry.toggle.style.height = `${controlSize.height}px`;
      entry.toggleMark.style.width = `${foldBadgeWidth(badgeCount)}px`;
      if (isCollapsed) entry.toggleMark.setText(String(hiddenCount));
      else if (node.children.length > 0) setIcon(entry.toggleMark, "minus");
      entry.toggle.setAttribute("aria-label", isCollapsed ? `${hiddenCount} 個のノードを展開` : "折りたたみ");
      entry.toggle.setAttribute("aria-expanded", String(!isCollapsed));
      if (node.children.length > 0) entry.element.setAttribute("aria-expanded", String(!collapsed.has(node.id)));
      else entry.element.removeAttribute("aria-expanded");
      const attachments = attachmentMarkdown(source && !source.root ? nodeBody(source.document, source.node) : nodeBody(document, node));
      const key = `${path}\0${node.title}\0${attachments}${source?.root ? "\0called-root" : ""}`;
      if (entry.key === key) continue;
      entry.key = key;
      this.removeChild(entry.component);
      entry.component = this.addChild(new Component());
      entry.content.empty();
      const current = entry;
      const changed = (): void => {
        if (this.entries.get(node.id) === current && current.key === key) this.changed();
      };
      // The calling item carries a small link mark before the called root's text; the text itself (`![[…]]`) is what the inline editor shows.
      if (source?.root) setIcon(entry.content.createSpan({ cls: "mappy-node-call-mark", attr: { "aria-hidden": "true" } }), "link");
      const label = entry.content.createDiv({ cls: "mappy-node-label" });
      // A note transclusion in a title renders as a link (as in the body), so a node never nests another note's rendering.
      const labelTask = node.title
        ? MarkdownRenderer.render(this.app, transclusionsAsLinks(node.title), label, path, entry.component)
        : Promise.resolve();
      const attachmentsEl = entry.content.createDiv({ cls: "mappy-node-attachments" });
      // A re-render while the node is being edited makes these elements again (an image pasted onto the node
      // being edited is exactly that), so the editor goes on standing in for the text it replaced.
      this.applyEditing(entry);
      const attachmentsTask = attachments
        ? MarkdownRenderer.render(this.app, attachments, attachmentsEl, bodyPath, entry.component).then(() => {
          // Keep rendered links and images, without reference labels or prose.
          const items = Array.from(attachmentsEl.querySelectorAll("a, .image-embed, img"))
            .filter(item => !item.parentElement?.closest("a, .image-embed"));
          attachmentsEl.replaceChildren(...items);
        })
        : Promise.resolve();
      entry.component.registerDomEvent(entry.content, "load", changed, true);
      entry.component.registerDomEvent(entry.content, "error", changed, true);
      // Both renders settled, even when the label's failure ended the pair early and the attachments still write.
      const drawn = Promise.allSettled([labelTask, attachmentsTask]);
      this.rendering.set(node.id, drawn);
      const rendered = (): void => {
        if (this.rendering.get(node.id) === drawn) this.rendering.delete(node.id);
        this.finished += 1;
        this.settle();
      };
      // The layout frame is asked for before the waiters of `idle()` wake, so they find it pending.
      void Promise.all([labelTask, attachmentsTask]).then(() => {
        changed();
      }).catch(() => {
        if (this.entries.get(node.id) === current && current.key === key) {
          label.setText(displayTitle(node.title));
          attachmentsEl.empty();
          this.changed();
        }
      }).finally(() => drawn.then(rendered));
    }
    // A removed node whose render was in flight is a change of its own, so the waiters woken here find a frame pending too.
    if (dropped) this.changed();
    this.settle();
  }

  /**
   * Resolves `true` once no Markdown render of a shown node is in flight (at once when none is): by then every
   * finished render has asked for its layout frame, so the sizes the next frame measures are the rendered ones.
   * Resolves `false` when no render finishes for `stall` ms (a hung post-processor or embed), so a caller is not
   * held; a slow map whose renders keep finishing is waited for. Images still loading are not waited for (they
   * report by `load`, and a remote one may never arrive).
   */
  idle(stall: number): Promise<boolean> {
    if (this.rendering.size === 0) return Promise.resolve(true);
    const win = this.layer.win;
    return new Promise(resolve => {
      let seen = this.finished;
      let timer = 0;
      const wake = (): void => { win.clearTimeout(timer); resolve(true); };
      const check = (): void => {
        if (this.finished === seen) { this.idleWaiters.delete(wake); resolve(false); return; }
        seen = this.finished;
        timer = win.setTimeout(check, stall);
      };
      timer = win.setTimeout(check, stall);
      this.idleWaiters.add(wake);
    });
  }

  private settle(): void {
    if (this.rendering.size > 0 || this.idleWaiters.size === 0) return;
    const waiters = Array.from(this.idleWaiters);
    this.idleWaiters.clear();
    for (const wake of waiters) wake();
  }

  sizes(): Map<string, { width: number; height: number }> {
    return new Map(Array.from(this.entries, ([id, entry]) => [id, {
      width: entry.element.offsetWidth, height: entry.element.offsetHeight,
    }]));
  }

  /**
   * Reads come first, writes after: a layout read (clientLeft) right after a style
   * write forces a synchronous reflow of every node, once per fold, so a deep
   * branch of 2,000 nodes took seconds to place (LEV-45).
   */
  place(nodes: PositionedNode[], folds: FoldPosition[]): void {
    const junctions = new Map<string, { x: number; y: number }>();
    for (const fold of folds) {
      const element = this.entries.get(fold.id)?.element;
      if (element) junctions.set(fold.id, { x: fold.x - element.clientLeft, y: fold.y - element.clientTop });
    }
    for (const node of nodes) {
      const entry = this.entries.get(node.id);
      if (!entry) continue;
      entry.element.style.transform = `translate(${node.x}px, ${node.y}px)`;
      const junction = junctions.get(node.id);
      if (junction) {
        entry.toggle.style.left = `${junction.x - node.x}px`;
        entry.toggle.style.top = `${junction.y - node.y}px`;
      }
    }
  }

  /** Only the outgoing and incoming entries change, so selection stays O(1) on large maps. */
  select(id: string | null): void {
    const previous = this.selectedId;
    this.selectedId = id;
    for (const key of [previous, id]) {
      const entry = key === null ? undefined : this.entries.get(key);
      if (!entry) continue;
      const active = key === id;
      entry.element.toggleClass("is-selected", active);
      entry.element.setAttribute("aria-selected", String(active));
      entry.element.tabIndex = active ? 0 : -1;
    }
  }

  /**
   * The inline editor has opened on this node, or left it. While it is open the node hides the text the editor
   * stands in for — and nothing else: its images stay on screen, so one pasted during the edit appears where the
   * user pasted it instead of when the draft is confirmed.
   */
  editing(id: string, editing: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.editing === editing) return;
    entry.editing = editing;
    this.applyEditing(entry);
    this.changed();
  }

  /** The node's own text: what the inline editor replaces (the calling item's link mark goes with it). */
  private applyEditing(entry: NodeEntry): void {
    for (const part of entry.content.querySelectorAll<HTMLElement>(".mappy-node-label, .mappy-node-call-mark")) {
      part.hidden = entry.editing;
    }
  }

  focus(id: string): void { this.entries.get(id)?.element.focus({ preventScroll: true }); }

  onunload(): void {
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
    this.rendering.clear();
    this.settle();
  }
}

/** Count the whole trees once, so nested folds still report all hidden nodes. */
function countDescendants(roots: readonly MindNode[]): Map<string, number> {
  const order: MindNode[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    order.push(node);
    for (const child of node.children) pending.push(child);
  }
  const counts = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index--) {
    const node = order[index];
    if (!node) continue;
    let count = 0;
    for (const child of node.children) count += 1 + (counts.get(child.id) ?? 0);
    counts.set(node.id, count);
  }
  return counts;
}
