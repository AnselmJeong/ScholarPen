# Note boxes and figure captions

Insert a box with `/note` (also searchable as `callout`, `alert`, or `읽는 법`). Its default title is **읽는 법**; edit the title directly in the box. The body supports the editor's rich text, inline equations and citations. Shift+Enter adds a line within the body. Nested paragraphs, lists and equations share the same box.

To convert existing explanation paragraphs, select their text and press **Note** in the formatting toolbar. Each selected paragraph becomes a note without replacing its inline content. Press Note again when only notes are selected to return them to ordinary paragraphs.

Quarto export writes `.callout-note` with the title, `appearance="simple"` and `icon="false"`. Markdown export uses a titled blockquote plus an invisible `scholarpen-note` comment so custom titles can be restored on import without confusing ordinary quotations with notes. Import and the file preview understand both formats, including nested content. Existing manuscripts are not automatically converted.

Figure captions display Markdown emphasis and KaTeX formulas such as `$\theta$` (one actual backslash before theta). Click the caption to edit its original text; Enter or leaving the input commits the edit. Caption math remains TeX in MD/QMD export. Legacy formulas whose commands all contain a doubled escaping layer are normalized for display and export, without rewriting the stored caption. Properly written matrix row separators remain intact.

Validation covers schema and JSON persistence, QMD/MD round trips, nested notes, formulas/citations, protected code examples, mounted editor rendering and caption edits. A local browser fixture verified the Note surface and the reported theta/plus-minus caption formulas. This is separate from installed-app verification.
