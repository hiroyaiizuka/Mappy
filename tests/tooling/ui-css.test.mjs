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
