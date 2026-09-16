import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import { GFM, parser } from "@lezer/markdown";
import type { MindDocument, MindNode } from "../core/markdown";
import { nodeBody } from "../core/body";
import { foldBadgeWidth, foldControlSize, type FoldPosition, type PositionedNode } from "../layout/layout";

interface NodeEntry {
  element: HTMLDivElement;
  content: HTMLDivElement;
  toggle: HTMLButtonElement;
  toggleMark: HTMLSpanElement;
  component: Component;
  key: string;
}

interface NodeAppearance {
  visualRootId: string;
  mode: "mindmap" | "timeline";
}

/** Each Markdown render owns a disposable child component. */
export class NodeRenderer extends Component {
  readonly entries = new Map<string, NodeEntry>();

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
    const descendantCounts = countDescendants(document.root);
    const retained = new Set(nodes.map(node => node.id));
    for (const [id, entry] of this.entries) {
      if (retained.has(id) || entry.element.hasClass("is-editing")) continue;
      this.removeChild(entry.component);
      entry.element.remove();
      this.entries.delete(id);
    }
    for (const node of nodes) {
      let entry = this.entries.get(node.id);
      if (!entry) {
        const element = this.layer.createDiv({ cls: "mappy-node", attr: {
          "data-node-id": node.id, role: "treeitem", tabindex: "-1",
        } });
        const content = element.createDiv({ cls: "mappy-node-content" });
        const toggle = element.createEl("button", { cls: "mappy-node-toggle", attr: { tabindex: "0", type: "button" } });
        const toggleMark = toggle.createSpan({ cls: "mappy-node-toggle-mark", attr: { "aria-hidden": "true" } });
        entry = { element, content, toggle, toggleMark, component: this.addChild(new Component()), key: "" };
        this.entries.set(node.id, entry);
      }
      const isCollapsed = collapsed.has(node.id) && node.children.length > 0;
      entry.element.toggleClass("is-root", node.id === appearance.visualRootId);
      entry.element.toggleClass("is-stage", node.parentId === appearance.visualRootId);
      entry.element.toggleClass("is-parent", node.children.length > 0);
      entry.element.toggleClass("is-timeline", appearance.mode === "timeline");
      entry.element.toggleClass("is-collapsed", isCollapsed);
      entry.element.setAttribute("aria-level", String(Math.max(1, node.level)));
      entry.element.setAttribute("aria-label", node.title.trim() || "空のノード");
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
      const attachments = attachmentMarkdown(nodeBody(document, node));
      const key = `${sourcePath}\0${node.title}\0${attachments}`;
      if (entry.key === key) continue;
      entry.key = key;
      this.removeChild(entry.component);
      entry.component = this.addChild(new Component());
      entry.content.empty();
      const label = entry.content.createDiv({ cls: "mappy-node-label" });
      const labelTask = node.title
        ? MarkdownRenderer.render(this.app, node.title, label, sourcePath, entry.component)
        : Promise.resolve();
      const attachmentsEl = entry.content.createDiv({ cls: "mappy-node-attachments" });
      const attachmentsTask = attachments
        ? MarkdownRenderer.render(this.app, attachments, attachmentsEl, sourcePath, entry.component).then(() => {
          // Keep rendered links and images, without reference labels or prose.
          const items = Array.from(attachmentsEl.querySelectorAll("a, .image-embed, img"))
            .filter(item => !item.parentElement?.closest("a, .image-embed"));
          attachmentsEl.replaceChildren(...items);
        })
        : Promise.resolve();
      const current = entry;
      const changed = (): void => {
        if (this.entries.get(node.id) === current && current.key === key) this.changed();
      };
      entry.component.registerDomEvent(entry.content, "load", changed, true);
      entry.component.registerDomEvent(entry.content, "error", changed, true);
      void Promise.all([labelTask, attachmentsTask]).then(() => {
        changed();
      }).catch(() => {
        if (this.entries.get(node.id) === current && current.key === key) {
          label.setText(node.title);
          attachmentsEl.empty();
          this.changed();
        }
      });
    }
  }

  sizes(): Map<string, { width: number; height: number }> {
    return new Map(Array.from(this.entries, ([id, entry]) => [id, {
      width: entry.element.offsetWidth, height: entry.element.offsetHeight,
    }]));
  }

  place(nodes: PositionedNode[], folds: FoldPosition[]): void {
    const foldPositions = new Map(folds.map(fold => [fold.id, fold]));
    for (const node of nodes) {
      const entry = this.entries.get(node.id);
      if (!entry) continue;
      entry.element.style.transform = `translate(${node.x}px, ${node.y}px)`;
      const fold = foldPositions.get(node.id);
      if (fold) {
        entry.toggle.style.left = `${fold.x - node.x - entry.element.clientLeft}px`;
        entry.toggle.style.top = `${fold.y - node.y - entry.element.clientTop}px`;
      }
    }
  }

  select(id: string | null): void {
    for (const [key, entry] of this.entries) {
      entry.element.toggleClass("is-selected", key === id);
      entry.element.setAttribute("aria-selected", String(key === id));
      entry.element.tabIndex = key === id ? 0 : -1;
    }
  }

  focus(id: string): void { this.entries.get(id)?.element.focus({ preventScroll: true }); }

  onunload(): void {
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }
}

/** Count the whole source tree once, so nested folds still report all hidden nodes. */
function countDescendants(root: MindNode): Map<string, number> {
  const order: MindNode[] = [];
  const pending = [root];
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

const attachmentParser = parser.configure(GFM);

/** Extract only link/image syntax; never render body code blocks or rewrite it. */
function attachmentMarkdown(body: string): string {
  if (!body.includes("[") && !body.includes("<") && !/(?:https?:\/\/|www\.)/u.test(body)) return "";
  const protectedRanges: { from: number; to: number }[] = [];
  const attachments: { from: number; to: number }[] = [];
  const references: string[] = [];
  const literalNodes = new Set(["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "HTMLTag", "CommentBlock", "Escape"]);
  attachmentParser.parse(body).iterate({
    enter(node) {
      if (literalNodes.has(node.name) || node.name === "LinkReference") {
        protectedRanges.push({ from: node.from, to: node.to });
        if (node.name === "LinkReference") references.push(body.slice(node.from, node.to));
        return false;
      }
      if (["Link", "Image", "Autolink", "URL"].includes(node.name)) {
        attachments.push({ from: node.from, to: node.to });
        return false;
      }
      return true;
    },
  });
  for (let position = 0; position < body.length;) {
    const from = body.indexOf("%%", position);
    if (from === -1) break;
    const literal = protectedRanges.find(range => range.from <= from && from < range.to);
    if (literal) { position = literal.to; continue; }
    const close = body.indexOf("%%", from + 2);
    const to = close === -1 ? body.length : close + 2;
    protectedRanges.push({ from, to });
    position = to;
  }
  for (const match of body.matchAll(/!?\[\[[^\r\n]+?\]\]/gu)) {
    attachments.push({ from: match.index, to: match.index + match[0].length });
  }
  const snippets: string[] = [];
  let lastEnd = -1;
  for (const range of attachments.sort((left, right) => left.from - right.from || right.to - left.to)) {
    if (range.from < lastEnd || protectedRanges.some(literal => range.from < literal.to && range.to > literal.from)) continue;
    let snippet = body.slice(range.from, range.to);
    // Note/PDF transclusions stay links; only image embeds become previews.
    if (snippet.startsWith("![[") && !/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[|#][^\]]*)?\]\]$/iu.test(snippet)) {
      snippet = snippet.slice(1);
    }
    snippets.push(snippet);
    lastEnd = range.to;
  }
  return snippets.length > 0 ? [...snippets, ...references].join("\n\n") : "";
}
