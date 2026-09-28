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

  // Writes refused by the store (src/obsidian/document-store.ts). `conflict` is what ConflictError says.
  conflict: "The note changed in Markdown. Update the map and edit again.",
  tabsDisagree: "Tabs editing this note disagree about its contents. Make them match in Markdown, then try again.",
  editorOpenedWhileSaving: "A Markdown editor opened while saving. Update the map and try again.",
  // A draft's error line (src/ui/inline-editor.ts, src/ui/edit-modal.ts): `refreshed` replaces `conflict` once the map has re-read the note.
  refreshed: "The note changed in Markdown. Press Enter again to apply this to the new content, or cancel to close.",
  saveFailed: "Couldn't save.",

  // Commands whose names other text repeats (the settings, a notice, the file menu); src/main.ts registers them by these.
  cmdCreateMap: "Create new mind map",
  cmdConvertNote: "Turn this note into a mind map",
  convertFirst: (command: string) => `Run "${command}" first.`,

  // New maps (src/obsidian/map-files.ts). `untitled` is written into the note as its title.
  untitled: "Untitled mind map",
  folderDotName: (path: string, setting: string) => `The folder "${path}" can't have a name starting with a dot. Check "${setting}" in the settings.`,
  folderIsFile: (path: string, setting: string) => `"${path}" is not a folder. Check "${setting}" in the settings.`,
  folderNotCreated: (path: string, setting: string) => `Couldn't create the folder "${path}". Check "${setting}" in the settings.`,

  // The map search (src/obsidian/map-search.ts).
  searchPlaceholder: "Search maps by title or path",
  searchNavigate: "Navigate",
  searchInsert: "Insert",
  searchClose: "Close",
  searchNoMaps: "No maps",
  searchNoMatch: "No matching maps",

  // Settings (src/obsidian/settings-tab.ts).
  themeFollow: "Follow Obsidian",
  themeLight: "Light",
  themeDark: "Dark",
  setTheme: "Theme",
  setThemeDesc: "Applies to the map view only. Embeds in notes and maps inserted into Excalidraw follow Obsidian's theme.",
  setDefaultLayout: "Default layout for new maps",
  setDefaultLayoutDesc: (create: string, convert: string) => `Written to mappy-layout by "${create}" and "${convert}". Notes that already exist keep their layout.`,
  setFolder: "Folder for new maps",
  setFolderDesc: "A path relative to the vault. Leave it empty to follow Obsidian's default location for new notes, or enter / for the vault root. A missing folder is created with the first map.",
  setFolderPlaceholder: "For example: Maps",
  setLayouts: "Layouts in the bottom-left corner",
  setLayoutsDesc: "The layout buttons in the map's bottom-left corner. The mind map can't be hidden. When an open note's mappy-layout is a hidden layout, that note still shows its button. Hiding a layout doesn't change how mappy-layout is saved and restored, the commands, embeds or inserting into Excalidraw.",
  setHiddenDefault: (layout: string) => `The default layout, ${layout}, isn't shown in the bottom-left corner. New maps still use it, and those notes show its button.`,
  setSaveFailed: "Couldn't save the settings.",

  // Excalidraw (src/obsidian/excalidraw-bridge.ts).
  dropStalled: "Some nodes haven't finished drawing, so the embed fits the map as far as it was drawn.",
  excalidrawInsertFailed: "Couldn't insert into Excalidraw.",
  excalidrawFitFailed: "Couldn't fit the Excalidraw embed to the map.",
  excalidrawImageFailed: (name: string) => `Couldn't load the image of ${name} into Excalidraw.`,
  excalidrawUpdateFailed: "Couldn't update the Excalidraw elements.",
  excalidrawOriginalKept: "Couldn't remove the original Markdown image.",
  excalidrawAttachmentKept: (path: string) => `Couldn't delete an attachment that wasn't used: ${path}`,
  excalidrawDrawFailed: (name: string) => `Couldn't draw the map ${name}.`,
  excalidrawMissing: "The Excalidraw plugin isn't available.",
  excalidrawOpenDrawing: "Open an Excalidraw drawing first.",
  excalidrawNoNodes: "There are no nodes to make a map from.",
  excalidrawAddFailed: "Couldn't add the elements to Excalidraw.",
  excalidrawLinksDropped: (count: number, links: string) => `Removed ${count} link(s) the drawing can't hold (${links}).`,
  listSeparator: ", ",

  // Image export in the vault (src/obsidian/image-export.ts).
  imageTimeout: (ms: number, url: string) => `The image took longer than ${ms} ms to fetch: ${url}`,
  imageFetchFailed: (status: number) => `Couldn't fetch the image: ${status}`,
  imageNotImage: (type: string) => `Not an image: ${type}`,
  imageUnknownType: "Unknown type",
  svgMalformed: (detail: string) => `The exported SVG isn't well-formed: ${detail}`,
  exportNoNodes: "There are no nodes to export.",
};

export type Messages = typeof en;
