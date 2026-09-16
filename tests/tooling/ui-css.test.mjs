import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("map editing CSS", () => {
  it("caps the inline node editor at three quarters of its former width", async () => {
    const css = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
    const rule = css.match(/\.mappy-view \.mappy-inline-input \{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    expect(rule).toMatch(/max-width:\s*303px;/u);
  });
});
