import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("map editing CSS", () => {
  it("caps the inline node editor at three quarters of its former width", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const rule = css.match(/\.mappy-view \.mappy-inline-input \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(rule).toMatch(/max-width:\s*303px;/u);
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
    // Every declaration of app.css's `button` rule that shapes a button is set again here, so the rows depend
    // on nothing Obsidian gives them; the selector's two classes outrank the app's bare `button`.
    for (const property of ["display", "align-items", "justify-content", "font-size", "font-weight", "border", "border-radius", "padding", "height", "background", "box-shadow", "white-space", "cursor"]) {
      expect(item, property).toMatch(new RegExp(`(?:^|;)\\s*${property}:`, "u"));
    }
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
    // Only custom properties: the block must not restyle anything by itself.
    const declarations = rule.split(";").map(line => line.trim()).filter(Boolean);
    expect(declarations.every(line => line.startsWith("--"))).toBe(true);
  });

  it("never selects Obsidian's theme classes outside the map container", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const selectors = css.replace(/\/\*[\s\S]*?\*\//gu, "").match(/[^{}]+(?=\{)/gu) ?? [];
    const themed = selectors.map(selector => selector.trim()).filter(selector => /\.theme-(?:light|dark)/u.test(selector));
    expect(themed.length).toBeGreaterThan(0);
    for (const selector of themed) {
      for (const part of selector.replace(/^:where\(|\)$/gu, "").split(",")) {
        expect(part.trim()).toMatch(/^\.mappy-view\.theme-(?:light|dark)\b/u);
      }
    }
  });
});
