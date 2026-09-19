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
