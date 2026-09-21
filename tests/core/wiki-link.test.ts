import { describe, expect, it } from "vitest";
import {
  addressUrl, autolinkUrl, exportedLink, externalUrl, hasUrlScheme, insertWikiLink, wikiLinkContext, wikiLinkPath,
} from "../../src/core/wiki-link";

describe("inline wikilink completion", () => {
  it("finds the active link after surrounding Japanese text", () => {
    expect(wikiLinkContext("参考は [[睡", 7)).toEqual({ from: 4, to: 7, query: "睡", suffix: "" });
  });

  it.each(["閉じた [[睡眠]]", "普通の入力", "[[睡眠#章", "[[睡眠|別名", "`[[code", "\\[[escaped"])("does not complete %s", text => {
    expect(wikiLinkContext(text, text.length)).toBeNull();
  });

  it("replaces only the active link, preserving following text and an existing alias", () => {
    const text = "前 [[no|表示名]] 後";
    const context = wikiLinkContext(text, 6);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, "資料/日本 語")).toEqual({
      value: "前 [[資料/日本 語|表示名]] 後", cursor: 17,
    });
  });

  it("retains an existing fragment when completing the file part", () => {
    const text = "[[no#Heading|名前]] tail";
    const context = wikiLinkContext(text, 4);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, "Notes/note").value).toBe("[[Notes/note#Heading|名前]] tail");
  });

  it("does not duplicate closing brackets, and preserves text outside the link", () => {
    const text = "A [[not]] B";
    const context = wikiLinkContext(text, 7);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, "note")).toEqual({ value: "A [[note]] B", cursor: 10 });
  });

  it("uses a selected alias without rewriting unrelated text", () => {
    const text = "参考 [[ねむ trailing";
    const context = wikiLinkContext(text, 7);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, "睡眠", "ねむり").value).toBe("参考 [[睡眠|ねむり]] trailing");
  });

  it("finds only the last unclosed pair on the current line", () => {
    const text = "[[first]] text [[next";
    expect(wikiLinkContext(text, text.length)?.query).toBe("next");
    expect(wikiLinkContext("[[first\nnext", 12)).toBeNull();
  });
});

describe("wikiLinkPath and hasUrlScheme (shared by the Excalidraw bridge and the SVG export)", () => {
  it.each([
    ["[[note#heading|alias]]", "note"],
    ["![[図.png|120]]", "図.png"],
    ["figure.png|120", "figure.png"],
    ["note^block", "note"],
    ["  Notes/spaced name.md  ", "Notes/spaced name.md"],
  ])("reduces %s to its linkpath", (link, path) => {
    expect(wikiLinkPath(link)).toBe(path);
  });

  it.each(["", "   ", "|alias", "#heading", null, undefined])("returns null for %s", link => {
    expect(wikiLinkPath(link)).toBeNull();
  });

  it("tells a URL with a scheme from a vault path", () => {
    expect(hasUrlScheme("https://example.com/a.png")).toBe(true);
    expect(hasUrlScheme("app://obsidian.md/x")).toBe(true);
    expect(hasUrlScheme("data:image/png;base64,AAAA")).toBe(true);
    expect(hasUrlScheme("Attachments/図.png")).toBe(false);
    expect(hasUrlScheme("C-drive:not a scheme?")).toBe(true);
    expect(hasUrlScheme("時間: 10:00")).toBe(false);
  });
});

describe("externalUrl (what a note's link may carry into another plugin's document)", () => {
  it.each([
    "https://example.com/a",
    "HTTPS://EXAMPLE.COM/a",
    "http://example.com",
    "mailto:someone@example.com",
    "obsidian://open?vault=x&file=y",
  ])("keeps %s", link => {
    expect(externalUrl(link)).toBe(link);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "app://obsidian.md/x",
    "vbscript:msgbox(1)",
  ])("refuses %s", link => {
    expect(externalUrl(link)).toBeNull();
  });

  it("refuses text with no scheme at all: a vault path is not an external URL", () => {
    expect(externalUrl("Attachments/図.png")).toBeNull();
    expect(externalUrl("[[睡眠ノート]]")).toBeNull();
    expect(externalUrl("")).toBeNull();
  });
});

describe("autolinkUrl (the scheme an autolink leaves for its reader to supply)", () => {
  it.each([
    ["www.example.com/a", "https://www.example.com/a"],
    ["www.example.com", "https://www.example.com"],
  ])("opens %s as %s", (text, url) => {
    expect(autolinkUrl(text)).toBe(url);
  });

  it.each([
    "https://example.com/a",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "Attachments/図.png",
    "睡眠ノート",
    "www",
    "",
  ])("leaves %s as it was written", text => {
    expect(autolinkUrl(text)).toBe(text);
  });

  it("leaves a bare address alone: GFM linkifies an attachment named like one", () => {
    // `file@2x.png` is how a retina image is named, and the parser calls it an email autolink. A blanket
    // `mailto:` would turn a link to a picture in the vault into a mail window (LEV-138).
    expect(autolinkUrl("file@2x.png")).toBe("file@2x.png");
    expect(autolinkUrl("someone@example.com")).toBe("someone@example.com");
  });

  it("leaves an upper-case `WWW.` as written: the parser never calls one a link", () => {
    expect(autolinkUrl("WWW.EXAMPLE.COM")).toBe("WWW.EXAMPLE.COM");
  });

  it("supplies a scheme without judging it: the allowed list is still `externalUrl`'s to apply", () => {
    expect(externalUrl(autolinkUrl("www.example.com/a"))).toBe("https://www.example.com/a");
  });
});

describe("addressUrl (a bare address autolink, once the vault has had its say)", () => {
  it.each([
    ["someone@example.com", "mailto:someone@example.com"],
    ["first.last+tag@mail.example.co.jp", "mailto:first.last+tag@mail.example.co.jp"],
  ])("opens %s as %s", (text, url) => {
    expect(addressUrl(text)).toBe(url);
  });

  it.each([
    // The parser calls these autolinks; the last label is no top-level domain, so they are versions, not mail.
    "react@18.2.0",
    "v2@1.0.1",
    // Not an address at all.
    "someone@example",
    "@example.com",
    "睡眠ノート",
    "",
    // Already carries a scheme of its own.
    "mailto:someone@example.com",
  ])("refuses %s", text => {
    expect(addressUrl(text)).toBeNull();
  });

  it("cannot tell an attachment from an address by itself: that is the vault's to answer", () => {
    // The shape is the same, so the caller resolves the name first and only then asks (`linkFor`).
    expect(addressUrl("file@2x.png")).toBe("mailto:file@2x.png");
  });
});

describe("exportedLink (what a file written out of a note may carry)", () => {
  it("keeps a vault link as written: inside Obsidian it is the note's own link", () => {
    expect(exportedLink("睡眠ノート")).toBe("睡眠ノート");
    expect(exportedLink("Attachments/図.png")).toBe("Attachments/図.png");
    expect(exportedLink("#見出し")).toBe("#見出し");
  });

  it.each(["https://example.com/a", "mailto:someone@example.com", "obsidian://open?vault=x&file=y"])("keeps %s", link => {
    expect(exportedLink(link)).toBe(link);
  });

  it.each(["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:msgbox(1)", "tel:0000", "file:///etc/passwd", ""])(
    "refuses %s",
    link => {
      expect(exportedLink(link)).toBeNull();
    },
  );

  it("refuses a scheme hidden behind the characters a URL parser throws away", () => {
    // A browser deletes tabs and line breaks inside a URL and trims the controls and spaces around it before
    // it reads the scheme, and the file's own escaping drops the same characters: judging the text as written
    // would let ` javascript:…` through as a vault path and then hand a working script to the click.
    expect(exportedLink(" javascript:alert(1)")).toBeNull();
    expect(exportedLink("\u0000javascript:alert(1)")).toBeNull();
    expect(exportedLink("java\tscript:alert(1)")).toBeNull();
    expect(exportedLink("java\nscript:alert(1)")).toBeNull();
    expect(exportedLink("\u000cjavascript:alert(1)")).toBeNull();
    expect(externalUrl(" javascript:alert(1)")).toBeNull();
    expect(hasUrlScheme(" javascript:alert(1)")).toBe(true);
  });

  it("writes the link the reader will see, not the one that was judged", () => {
    expect(exportedLink(" https://example.com/a ")).toBe("https://example.com/a");
    expect(exportedLink("https://example.com/\na")).toBe("https://example.com/a");
    expect(externalUrl(" https://example.com/a")).toBe("https://example.com/a");
  });

  it("refuses `//host/path`: no scheme, and no note either", () => {
    // A file served over http(s) would follow it out of the vault; nothing in a note means this.
    expect(exportedLink("//example.com/x")).toBeNull();
    expect(exportedLink("/Attachments/図.png")).toBe("/Attachments/図.png");
  });
});
