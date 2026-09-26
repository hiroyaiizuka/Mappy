/**
 * One way of measuring a node's box around the inline editor (LEV-203), shared by the browser verification page
 * (`scripts/browser-harness-capture.mjs`, `new-node-*`) and the Obsidian case E43 (`scripts/e2e/new-node-input.mjs`),
 * so that the headless run and the real one check the same thing.
 */

/**
 * Page-side source of `(node, draft) => box`: the node's box in world units — the layout's position of the node
 * (its `translate`) and its size at scale 1 — so that a pan of the viewport (confirming selects the node, which can
 * bring a wide one into view) is not read as the box moving. With the draft open, also its rows, its height, whether
 * its whole text is selected, and how far below the top of the node's text box it starts.
 */
export const MEASURE_NODE_BOX = `(node, draft) => {
  const rect = node.getBoundingClientRect();
  const scale = rect.width / node.offsetWidth;
  const placed = node.style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/u);
  const box = { x: Number(placed?.[1]), y: Number(placed?.[2]), width: rect.width / scale, height: rect.height / scale,
    title: node.querySelector('.mappy-node-label')?.textContent ?? '' };
  if (!draft) return box;
  const line = parseFloat(getComputedStyle(draft).lineHeight);
  const style = getComputedStyle(node);
  const top = rect.y + (parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth)) * scale;
  return { ...box, value: draft.value, rows: Math.round(draft.offsetHeight / line), draftHeight: draft.offsetHeight, line,
    selected: draft.selectionStart === 0 && draft.selectionEnd === draft.value.length,
    offsetTop: (draft.getBoundingClientRect().y - top) / scale };
}`;

/** The same box: position and size within half a pixel. */
export const sameBox = (left, right) => ['x', 'y', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) <= 0.5);

export const showBox = box => `${box.width.toFixed(1)}×${box.height.toFixed(1)}@${box.x},${box.y}`;

/** What is wrong with an open draft of `rows` rows: it must be exactly its rows high and start at the node's text box, so the caret sits in the middle of a row. */
export function draftProblems(draft, rows, label) {
  const problems = [];
  if (draft.rows !== rows) problems.push(`${label}: the draft has ${draft.rows} rows, not ${rows}`);
  if (Math.abs(draft.draftHeight - rows * draft.line) > 1) problems.push(`${label}: the draft is ${draft.draftHeight}px high for ${rows} rows of ${draft.line}px`);
  if (Math.abs(draft.offsetTop) > 0.5) problems.push(`${label}: the draft starts ${draft.offsetTop.toFixed(1)}px below the node's text box`);
  return problems;
}
