/**
 * Web search and material, the person's decision of 2026-10-02 (A): when material (a PDF, a note, subtitles) is
 * attached, web search starts off and the person can turn it back on, which shows a caution (README #44 discloses it).
 * Material is outside text: with web tools, an instruction written in it could send what the run holds (the node, the
 * material) to a URL. The one place the rule lives: the input (src/ui/ai/ai-controller.ts) asks these.
 */

/** Web search once a material is added: the first one turns it off, later ones leave the person's choice alone. */
export function webSearchAfterAttach(webSearch: boolean, attachedBefore: number): boolean {
  return attachedBefore === 0 ? false : webSearch;
}

/** Whether the input shows the caution: web search is on while material is attached. */
export function webSearchCaution(materialCount: number, webSearch: boolean): boolean {
  return webSearch && materialCount > 0;
}
