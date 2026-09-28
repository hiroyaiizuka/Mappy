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
  refreshed: "The note changed in Markdown. Confirm again to apply this to the new content, or cancel to close.",
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

  // Commands, the ribbon and the file menu (src/main.ts). Obsidian shows the plugin's name before each command.
  cmdOpen: "Open mind map",
  cmdOpenSplit: "Open mind map beside Markdown",
  cmdToggle: "Switch between map and Markdown",
  cmdRemove: "Turn off mind map for this note",
  cmdInsertExcalidraw: "Insert current map into Excalidraw drawing",
  cmdExport: "Export current map as SVG or PNG",
  cmdCallMap: "Search and insert a map",
  cmdConvertToList: "Change current map to list format",
  menuRemove: "Turn off mind map",
  createFailed: "Couldn't create the mind map.",
  openFailed: "Couldn't open the map.",
  markdownOpenFailed: "Couldn't open Markdown.",
  removeFailed: "Couldn't turn off the mind map.",
  convertNoteFailed: "Couldn't turn the note into a mind map.",
  formatFailed: "Couldn't change the format.",
  callFailed: "Couldn't insert the map.",
  openMarkdownNote: "Open a Markdown note.",
  exportedTo: (path: string) => `Exported to ${path}.`,
  exportFailed: "Couldn't export.",
  exportStartFailed: "Couldn't start the export.",
  // The two plugin items of the view's actions popover (§5 M3).
  popCallDesc: "Insert another map",
  popExport: "Export",
  popExportDesc: "Save as SVG or PNG",

  // The export dialog (src/ui/export-modal.ts).
  exportLead: "Saves the current layout and folds, as the current theme shows them, to the attachment folder. The note itself isn't changed.",
  exportFontNote: "Fonts aren't embedded, so text widths and line wrapping depend on the fonts where the file is viewed.",
  exportSvgOnly: "PNG can't be made here, so only SVG can be exported.",
  exportTitle: "Export as SVG or PNG",
  exportFormat: "Format",

  // Editing a node (src/ui/inline-editor.ts, src/ui/edit-modal.ts).
  nodeTextLabel: "Node text",
  cancel: "Cancel",
  save: "Save",

  // The map view (src/ui/mindmap-view.ts). `mainTopicTitle`, `newNodeTitle` and `newTopicTitle` are written into the note:
  // a node added right under a root is a main topic, one further down a subtopic (LEV-250), a free topic a topic.
  mainTopicTitle: "Main topic",
  newNodeTitle: "Subtopic",
  newTopicTitle: "Topic",
  noteChanged: "The note has changed. Open the original note and try again.",
  exportRenderStalled: "Some nodes haven't finished drawing, so the map is exported as it looks on screen.",
  nodeGone: "The node being edited isn't in the Markdown any more. Select the node in the map again.",
  calledReadOnly: "Inserted maps are read-only. Double-click to open the original map.",
  exportNoMap: "Open a map before exporting.",
  exportEditing: "Finish editing the text before exporting.",
  exportDragging: "Finish dragging before exporting.",
  exportMapChanged: "The map was closed or switched to another note. Open it again, then export.",
  exportNoLayout: "Wait for the map to finish laying out before exporting.",
  viewTitle: (name: string) => `${name} · map`,
  viewTitleEmpty: "Mind map",
  draftNotSaved: (reason: string) => `Couldn't save the text being edited. ${reason}`,
  // A draft left open when the window reloaded or Obsidian quit, applied when Mappy loads again (src/ui/exit-drafts.ts).
  exitDraftNotSaved: (title: string, note: string, reason: string) => `Couldn't save "${title}" in ${note}, which was being edited when Obsidian reloaded or quit. ${reason}`,
  exitNoteChanged: "The note changed in the meantime.",
  exitNoteGone: "The note is no longer in the vault.",
  exitDraftExpired: "It was kept for more than a day, so it wasn't written.",
  layoutsLabel: "Layouts",
  actions: "Actions",
  mapLabel: "Mind map. Enter adds a sibling, Tab adds a child, F2 edits.",
  emptyState: "Select a Markdown note, then open a mind map from the command palette.",
  zoomLabel: "Zoom",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoomFit: "Fit to view",
  addTopic: "Add topic",
  openOriginal: "Open original map",
  collapse: "Collapse",
  deleteTopic: "Delete topic",
  deleteBranch: "Delete branch",
  moveUp: "Move up",
  moveDown: "Move down",
  toListFormat: "Change to list format",
  actionFailed: "Couldn't complete the action.",
  editText: "Edit text",
  editBody: "Edit body and links",
  addImage: "Add image",
  addChild: "Add child",
  addSibling: "Add sibling",
  toMarkdown: "Switch to Markdown",
  toMarkdownDesc: "Open the note in this tab",
  undo: "Undo",
  redo: "Redo",
  callSelf: "A map can't insert itself.",
  savingWait: "Wait for saving to finish, then try again.",
  rootIsFileName: "This node is the file name. You can add child nodes to it.",
  draftChanged: "The text being edited changed in Markdown. Cancel and check the new content.",
  formatWhileEditing: "Finish editing the text before changing the format.",
  convertedToList: "Changed to H2 headings and list format. Undo restores it.",
  chooseImage: "Choose an image file.",
  imageTooLarge: "Images must be 20 MB or smaller.",
  imageNoteUpdated: "The note was updated. Add the image again.",
  imageSavedRetry: (path: string) => `The image was saved to ${path}. Try inserting it into the note again.`,

  // Nodes (src/ui/node-renderer.ts).
  emptyNode: "Empty node",
  insertedFrom: (path: string) => `Inserted from: ${path}`,
  expandHidden: (count: number) => (count === 1 ? "Expand 1 hidden node" : `Expand ${count} hidden nodes`),

  // Maps drawn off screen and embeds (src/ui/offscreen-map.ts, src/ui/map-embed.ts, src/ui/link-suggest.ts).
  notAMap: (name: string) => `${name} isn't a map.`,
  drawStopped: (name: string) => `Drawing ${name} was stopped.`,
  embedLabel: (name: string) => `Mind map: ${name}`,
  openInMap: "Open in map",
  embedLoadFailed: (name: string) => `Couldn't load ${name}.`,
  embedNotAMap: (name: string) => `${name} is no longer a map. Reopen the note to show it as usual.`,
  embedNoHeading: (name: string, heading: string) => `${name} has no heading "${heading}".`,
  linkSuggestions: "Link suggestions",
};

export type Messages = typeof en;
