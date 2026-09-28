/**
 * The UI's English text, and the source of truth for the keys (docs/architecture.md §9e). `ja.ts` has to
 * give every key here a value of the same type: a string, or a function taking the same arguments for text
 * that has values spliced in. Keys are kept short because esbuild's minifier leaves property names as written.
 *
 * `ui/sentence-case-locale-module` checks the plain strings here (eslint.config.mjs); it does not look inside
 * the functions, so their English is checked by tests/i18n and review only.
 */
export const en = {
  // Layout names (core/layout-mode.ts): the layout buttons and the settings both show them.
  layoutMindmap: "Mind map",
  layoutTimeline: "Timeline",
  layoutHierarchy: "Hierarchy",
  layoutBalanced: "Balanced",

  // Edits refused by core (src/core): they reach the user through a notice or the editor's error line.
  editRangeInvalid: "The edit range is invalid.",
  editRangeOverlap: "The edit ranges overlap.",
  headingsUnsafe: "Can't change the heading structure safely. Check the Markdown syntax.",
  listUnsafe: "Can't change the list structure safely. Check the Markdown syntax.",
  moveIntoSelf: "A node can't be moved under itself or its descendants.",
  moveTargetInvalid: "The destination is invalid.",
  headingDepthSubtree: "Headings, including their descendants, can only go 6 levels deep.",
  headingMarkerMissing: "Can't find where to edit the heading.",
  nameHasBreak: "A node name can't contain line breaks.",
  setextEmpty: "A setext heading can't be empty. Change it to an ATX heading in Markdown.",
  nameChangesHeading: "This name would change the heading syntax. Edit it in Markdown.",
  headingDepth: "Headings can only go 6 levels deep.",
  topicAtEndUnsafe: "Can't add a topic at the end of the note. Check the Markdown syntax.",
  topicsKeyUnsafe: "Can't update mappy-topics in the frontmatter. Check it in Markdown.",
  rootAddsChildOnly: "The root can only have children added.",
  detachListOnly: "Only list branches can be detached.",
  mainRootMove: "The main root can't be moved under another node.",
  listBranchTarget: "Move a list branch under an H2 root or another list item.",
  nodeChanged: "The node has changed. Select it again.",
  topicChanged: "The topic has changed. Select it again.",
  frontmatterOpen: "Close the frontmatter in Markdown first.",
  layoutNameInvalid: "The layout name is invalid.",
  topicPositionInvalid: "The topic position is invalid.",
  topicHeadingOneLine: "A topic heading must be a single line.",
  bodyAffectsHeadings: "The body would change the headings around it. Check for an unclosed code block or comment.",
  bodyAffectsList: "The body would change the list levels around it. Check the indentation.",
  lineBreakUnsafe: "A line break can't go here (inside inline code, a link or math, or right after a backslash). Remove the line break or edit it in Markdown.",
  listBodyShape: "Some body text, such as a bulleted list, would change the node structure, so the map can't be converted safely. Separate the body from the nodes in Markdown.",
  noHeadingsToConvert: "There are no headings to convert.",

  // Image export (src/export).
  pngUnavailable: "PNG can't be made here. Export as SVG instead.",
  svgLoadFailed: "Couldn't load the SVG as an image.",
  pngFailed: "Couldn't create the PNG.",
};

export type Messages = typeof en;
