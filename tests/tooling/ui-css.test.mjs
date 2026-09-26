import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("map editing CSS", () => {
  it("wraps the inline node editor and the confirmed label at the same width, in the label's weight (LEV-198)", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const rule = selector => css.match(new RegExp(`${selector.replace(/[.()]/gu, "\\$&")} \\{(?<body>[^}]*)\\}`, "u"))?.groups?.body ?? "";
    // The confirmed map keeps its look (本人判断 2026-09-26, 案 B): the node caps are the ones from before LEV-198,
    // and nothing narrower sits between the node and its label or attachments.
    expect(rule(".mappy-view .mappy-node")).toMatch(/max-width:\s*420px;/u);
    expect(rule(".mappy-view .mappy-node")).toMatch(/font-size:\s*var\(--font-text-size\);/u);
    expect(rule(".mappy-view .mappy-node.is-root")).toMatch(/max-width:\s*360px;/u);
    expect(rule(".mappy-view .mappy-node-content")).not.toMatch(/max-width/u);
    expect(rule(".mappy-view .mappy-inline-error")).toMatch(/max-width:\s*303px;/u);
    // The draft sizes itself to its text up to the node's content box, where the label wraps; it fills the node, so a
    // click beside the text stays in the editor.
    const input = rule(".mappy-view .mappy-inline-input");
    expect(input).toMatch(/field-sizing:\s*content;/u);
    // No floor of its own (LEV-203): a floor the node does not share sticks out of an empty node or resizes it when
    // the draft closes, and Obsidian's Chromium 124 counted none of `max(40px, 100%)` toward the node's width.
    expect(input).toMatch(/min-width:\s*100%;/u);
    expect(input).not.toMatch(/max\(/u);
    expect(input).toMatch(/max-width:\s*100%;/u);
    expect(input).not.toMatch(/(^|[^-])width:\s*100%/u);
    // The label's weight (400) whatever a theme gives the ancestors, and one row as high as the label's line (LEV-203:
    // the 26px floor put the caret above the middle and made the node 34px while editing, 28 or 30.4 once confirmed).
    expect(input).toMatch(/font: inherit;[\s\S]*font-weight:\s*400;/u);
    expect(input).toMatch(/min-height:\s*0;/u);
    expect(css).toMatch(/\.mappy-node\.is-root > \.mappy-inline-input \{ font-weight: 700; \}/u);
    expect(css).toMatch(/\.mappy-node\.is-stage > \.mappy-inline-input \{ font-weight: 600; \}/u);
    expect(css).not.toMatch(/--mappy-text-wrap|@property/u);
    // The one-row width InlineEditor.resize reads.
    // No min-width while measuring: `100%` would floor the reading at the node's width.
    expect(rule(".mappy-view .mappy-inline-input.is-measuring")).toMatch(/width:\s*0;\s*min-width:\s*0;\s*padding-right:\s*1px;\s*white-space:\s*pre;/u);
    // Spacing a theme gives the label reaches the draft too (the UA resets it on a textarea).
    for (const property of ["letter-spacing", "word-spacing", "text-transform"]) expect(input).toMatch(new RegExp(`${property}:\\s*inherit;`, "u"));
  });

  it("gives an empty node and an emptied draft one box, one line high (LEV-203)", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    // The same floor on both sides of the editor, so opening or closing it on an empty node changes nothing.
    // A node showing attachments under its empty title (an image pasted onto an untitled node) keeps its old box (review 2).
    const bare = ':not\\(:has\\(> \\.mappy-node-content > \\.mappy-node-attachments:not\\(:empty\\)\\)\\)';
    expect(css).toMatch(new RegExp(`\\.mappy-view \\.mappy-node\\.is-empty:not\\(\\.is-editing\\)${bare},\\n\\.mappy-view \\.mappy-node\\.is-editing\\.is-draft-empty${bare} \\{ min-width: 96px; \\}`, 'u'));
    // An empty label takes a line (a zero-width space), as the draft's one row does.
    expect(css).toMatch(new RegExp(`\\.mappy-node\\.is-empty${bare} > \\.mappy-node-content > \\.mappy-node-label::before \\{ content: "\\\\200b"; \\}`, 'u'));
  });

  it("turns Obsidian's hover tooltips off over the map, fold controls aside (LEV-199)", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    // The property inherits: set on the canvas, it reaches the nodes' parts and the inline input; the toggles take it back.
    expect(css).toMatch(/\.mappy-view \.mappy-canvas \{\s*--no-tooltip:\s*true;\s*\}/u);
    expect(css).toMatch(/\.mappy-view \.mappy-node-toggle \{\s*--no-tooltip:\s*false;\s*\}/u);
  });

  it("draws the drag preview connector and slot frame in the lighter drop blue, not the selection blue", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/--mappy-drop:\s*#2cbdff;/u);
    const connector = css.match(/\.mappy-edges path\.is-preview \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(connector).toMatch(/stroke:\s*var\(--mappy-drop\);/u);
    expect(connector).toMatch(/stroke-linecap:\s*round;/u);
    const frame = css.match(/\.mappy-drop-placeholder \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(frame).toMatch(/border:\s*1\.5px solid var\(--mappy-drop\);/u);
  });
});

describe("the 操作 popover CSS (§5 M3)", () => {
  it("draws the card with Obsidian's surface variables, scoped to the view, sized by the view and above the floating controls", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const card = css.match(/\.mappy-view \.mappy-popover \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(card).toMatch(/position:\s*absolute;/u);
    // The caps (320px at most, the pane's room) are the view's inline styles, in one place; the sheet only lets a capped card scroll.
    expect(card).not.toMatch(/max-width|max-height/u);
    expect(card).toMatch(/width:\s*max-content;/u);
    expect(card).toMatch(/overflow-y:\s*auto;/u);
    expect(card).toMatch(/border:\s*1px solid var\(--background-modifier-border\);/u);
    expect(card).toMatch(/border-radius:\s*var\(--radius-m\);/u);
    expect(card).toMatch(/background:\s*var\(--background-secondary\);/u);
    expect(card).toMatch(/box-shadow:\s*var\(--shadow-s\);/u);
    const z = Number(card.match(/z-index:\s*(?<z>\d+);/u)?.groups?.z);
    const floating = Number((css.match(/\.mappy-view \.mappy-floating \{(?<body>[^}]*)\}/u)?.groups?.body ?? "").match(/z-index:\s*(?<z>\d+);/u)?.groups?.z);
    expect(z).toBeGreaterThan(floating);
    // The description is one line, cut with an ellipsis when the pane is narrow, in the muted colour.
    const description = css.match(/\.mappy-view \.mappy-popover-description \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(description).toMatch(/white-space:\s*nowrap;/u);
    expect(description).toMatch(/text-overflow:\s*ellipsis;/u);
    expect(description).toMatch(/color:\s*var\(--text-muted\);/u);
    // Every popover rule is scoped to the view.
    const selectors = css.replace(/\/\*[\s\S]*?\*\//gu, "").match(/[^{}]+(?=\{)/gu) ?? [];
    const popover = selectors.map(selector => selector.trim()).filter(selector => selector.includes("mappy-popover"));
    expect(popover.length).toBeGreaterThan(3);
    for (const selector of popover) {
      for (const part of selector.split(",")) expect(part.trim()).toMatch(/^\.mappy-view /u);
    }
  });

  it("lines the three rows up at the card's left edge, each as wide as the card (LEV-84)", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const card = css.match(/\.mappy-view \.mappy-popover \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(card).toMatch(/flex-direction:\s*column;/u);
    expect(card).toMatch(/align-items:\s*stretch;/u);
    const item = css.match(/\.mappy-view \.mappy-popover-item \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(item).toMatch(/width:\s*100%;/u);
    // app.css centres a button's content; a row narrower than the card would then put its icon elsewhere.
    expect(item).toMatch(/justify-content:\s*flex-start;/u);
    expect(item).toMatch(/text-align:\s*left;/u);
    // Every declaration of app.css's `button` rule that sizes, places or colours a button is set again here (its
    // cursor too; user-select, outline and transition are left to the app), so a row's box depends on nothing
    // Obsidian gives it. The two classes outrank the app's `button` and `button:not(.clickable-icon)`; the
    // tablet padding rule `.is-tablet button:not(.clickable-icon)` (0,2,1) is not outranked — LEV-85.
    for (const property of ["display", "align-items", "justify-content", "color", "font-size", "font-weight", "border", "border-radius", "padding", "height", "background", "box-shadow", "white-space", "cursor"]) {
      expect(item, property).toMatch(new RegExp(`(?:^|;)\\s*${property}:`, "u"));
    }
    // A disabled row is the faint colour only; app.css would also dim `button[aria-disabled="true"]` to 0.7.
    const disabled = css.match(/\.mappy-view \.mappy-popover-item\.is-disabled \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(disabled).toMatch(/color:\s*var\(--text-faint\);/u);
    expect(disabled).toMatch(/opacity:\s*1;/u);
  });
});

describe("map theme CSS (settings, M14)", () => {
  it("re-derives the semantic variables from the palette on the themed container only, at zero specificity", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const rule = css.match(/:where\(\.mappy-view\.theme-light, \.mappy-view\.theme-dark\) \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(rule).not.toBe("");
    // The mapping Obsidian's app.css uses on body, so a community theme's palette applies inside the container.
    expect(rule).toMatch(/--background-primary:\s*var\(--color-base-00\);/u);
    expect(rule).toMatch(/--text-normal:\s*var\(--color-base-100\);/u);
    expect(rule).toMatch(/--text-muted:\s*var\(--color-base-70\);/u);
    expect(rule).toMatch(/--background-modifier-hover:\s*rgba\(var\(--mono-rgb-100\), 0\.075\);/u);
    expect(rule).toMatch(/--interactive-accent:\s*var\(--color-accent-1\);/u);
    expect(rule).toMatch(/--link-color:\s*var\(--text-accent\);/u);
    expect(rule).toMatch(/--code-background:\s*var\(--background-primary-alt\);/u);
    // The caret too: app.css fixes `--caret-color` on body from the text colour (1.6.7 and 1.14.2 alike).
    expect(rule).toMatch(/--caret-color:\s*var\(--text-normal\);/u);
    // Only custom properties: the block must not restyle anything by itself.
    const declarations = rule.split(";").map(line => line.trim()).filter(Boolean);
    expect(declarations.every(line => line.startsWith("--"))).toBe(true);
  });

  it("reads the caret variable again on the map container, as body does, so the inline input's caret is the map's text colour (LEV-93)", async () => {
    const css = (await readFile(new URL("../../styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
    // app.css fixes `caret-color: var(--caret-color)` on body, and a descendant inherits body's computed colour: the
    // re-derived variable reaches the inline input only through a rule that reads it again, next to `color`.
    const view = css.match(/(?:^|\n)\.mappy-view \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(view).toMatch(/(?:^|;)\s*color:\s*var\(--text-normal\);/u);
    expect(view).toMatch(/(?:^|;)\s*caret-color:\s*var\(--caret-color\);/u);
    // The one declaration of the property: no rule between the container and the textarea sets the caret on its own.
    expect(css.match(/(?:^|[;{\s])caret-color:/gu)).toHaveLength(1);
    // On mobile app.css points the caret at the accent instead; the themed container follows, still matching itself only.
    const mobile = css.match(/:where\(\.is-mobile \.mappy-view\.theme-light, \.is-mobile \.mappy-view\.theme-dark\) \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(mobile.split(";").map(line => line.trim()).filter(Boolean)).toEqual(["--caret-color: var(--text-accent)"]);
    expect(css.indexOf(":where(.is-mobile")).toBeGreaterThan(css.indexOf(":where(.mappy-view.theme-light"));
  });

  it("never selects Obsidian's theme classes outside the map container", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const selectors = css.replace(/\/\*[\s\S]*?\*\//gu, "").match(/[^{}]+(?=\{)/gu) ?? [];
    const themed = selectors.map(selector => selector.trim()).filter(selector => /\.theme-(?:light|dark)/u.test(selector));
    expect(themed.length).toBeGreaterThan(0);
    for (const selector of themed) {
      for (const part of selector.replace(/^:where\(|\)$/gu, "").split(",")) {
        // `.is-mobile` is body's class; a rule may look up to it, but the element it selects is still the container.
        expect(part.trim()).toMatch(/^(?:\.is-mobile )?\.mappy-view\.theme-(?:light|dark)\b/u);
      }
    }
  });
});
