import React, { useMemo, useState } from "react";
import { BlockNoteSchema, createParagraphBlockSpec, defaultStyleSpecs, mergeCSSClasses } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import {
  PositionPopover,
  Thread,
  type ThreadProps,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useDictionary,
  useEditorState,
  useExtension,
  useExtensionState,
  type FloatingUIOptions,
} from "@blocknote/react";
import { flip, offset, shift } from "@floating-ui/react";
import { TextSelection } from "prosemirror-state";
import type { ThreadMeta } from "../../shared/collab/threads";

// Same schema BlockNote uses for comment bodies: paragraphs without colors.
const { textColor: _textColor, backgroundColor: _backgroundColor, ...commentStyleSpecs } = defaultStyleSpecs;
const commentEditorSchema = BlockNoteSchema.create({
  blockSpecs: { paragraph: createParagraphBlockSpec() },
  styleSpecs: commentStyleSpecs,
});

/**
 * True for a plain Enter meant as "submit": not Shift+Enter (line break), not
 * with other modifiers, and not the Enter that only commits an IME
 * composition (e.g. Korean input).
 */
function isSubmitEnter(event: React.KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  return !(event.nativeEvent.isComposing || event.keyCode === 229);
}

/**
 * Editors whose next comment is about the whole manuscript (opened from the
 * slash menu without a selection). The composer takes the flag when it opens.
 */
const manuscriptComments = new WeakSet<BlockNoteEditor<any, any, any>>();

/** New-comment card: Enter saves (and hands the comment to the AI), Shift+Enter inserts a line break. */
function ScholarFloatingComposer() {
  const editor = useBlockNoteEditor<any, any, any>();
  const comments = useExtension(CommentsExtension);
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const [wholeManuscript] = useState(() => manuscriptComments.delete(editor));
  const commentEditor = useCreateBlockNote({
    trailingBlock: false,
    dictionary: { ...dict, placeholders: {
      emptyDocument: wholeManuscript ? "Ask for a change anywhere in the manuscript…" : dict.placeholders.new_comment,
    } },
    schema: comments.commentEditorSchema || commentEditorSchema,
  });
  const isEmpty = useEditorState({ editor: commentEditor, selector: ({ editor }) => editor.isEmpty });

  const save = async () => {
    if (commentEditor.isEmpty) return;
    // Every new comment goes straight to ScholarPen AI; no separate "Ask" step.
    const metadata: ThreadMeta = {
      assignee: "ai", status: "open", requestedAt: Date.now(),
      ...(wholeManuscript ? { scope: "document" as const } : {}),
    };
    await comments.createThread({ initialComment: { body: commentEditor.document }, metadata });
    comments.stopPendingComment();
  };

  return (
    <Components.Comments.Card className="bn-thread" headerText={wholeManuscript ? "Whole manuscript" : undefined}>
      <div
        onKeyDownCapture={(event) => {
          if (!isSubmitEnter(event)) return;
          event.preventDefault();
          event.stopPropagation();
          void save();
        }}
      >
        <Components.Comments.Editor
          autoFocus
          editable
          className="bn-comment-editor"
          editor={commentEditor}
          onFocus={() => {}}
          onBlur={() => {}}
        />
      </div>
      <div className="bn-comment-actions-wrapper">
        <Components.Generic.Toolbar.Root
          className={mergeCSSClasses("bn-action-toolbar", "bn-comment-actions")}
          variant="action-toolbar"
        >
          <Components.Generic.Toolbar.Button
            className="bn-button"
            mainTooltip="Save (Enter) · New line (Shift+Enter)"
            variant="compact"
            isDisabled={isEmpty}
            onClick={() => void save()}
          >
            Save
          </Components.Generic.Toolbar.Button>
        </Components.Generic.Toolbar.Root>
      </div>
    </Components.Comments.Card>
  );
}

/**
 * BlockNote's thread card with the same keys as the new-comment card: in the
 * reply box, or while editing a comment, Enter presses that editor's Save
 * button and Shift+Enter inserts a line break.
 */
export function ScholarFloatingThread(props: ThreadProps) {
  return (
    <div
      style={{ display: "contents" }}
      onKeyDownCapture={(event) => {
        if (!isSubmitEnter(event)) return;
        const commentEditor = (event.target as HTMLElement).closest(".bn-comment-editor");
        if (!commentEditor?.parentElement) return;
        event.preventDefault();
        event.stopPropagation();
        commentEditor.parentElement
          .querySelector<HTMLButtonElement>(":scope > .bn-comment-actions-wrapper .bn-comment-actions button:not([disabled])")
          ?.click();
      }}
    >
      <Thread {...props} />
    </div>
  );
}

/**
 * Replaces BlockNote's FloatingComposerController. BlockNote anchors the card
 * to the whole selection, so a selection taller than the free space above and
 * below it pushes the card out of the scroll container where it is clipped.
 * Anchoring to the selection end (where the pointer was released) keeps the
 * card next to a single line, which always fits on one side.
 */
export function ScholarFloatingComposerController() {
  const editor = useBlockNoteEditor<any, any, any>();
  const comments = useExtension(CommentsExtension);
  const pendingComment = useExtensionState(CommentsExtension, {
    editor,
    selector: (state) => state.pendingComment,
  });
  const position = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!pendingComment) return undefined;
      const head = editor.prosemirrorState.selection.head;
      return { from: head, to: head };
    },
  });

  const floatingUIOptions = useMemo<FloatingUIOptions>(() => ({
    useFloatingOptions: {
      open: !!pendingComment,
      onOpenChange: (open) => {
        if (!open) {
          comments.stopPendingComment();
          editor.focus();
        }
      },
      placement: "bottom",
      middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
    },
    focusManagerProps: { disabled: false },
    elementProps: { style: { zIndex: 60 } },
  }), [comments, editor, pendingComment]);

  return (
    <PositionPopover position={position} {...floatingUIOptions}>
      <ScholarFloatingComposer />
    </PositionPopover>
  );
}

/** Inline content range [from, to) of the block with this id, or null. */
function blockTextRange(editor: BlockNoteEditor<any, any, any>, blockId: string) {
  let range: { from: number; to: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (range) return false;
    if (node.type.name !== "blockContainer" || node.attrs.id !== blockId) return true;
    const content = node.firstChild;
    if (content?.isTextblock) range = { from: pos + 2, to: pos + 2 + content.content.size };
    return false;
  });
  return range as { from: number; to: number } | null;
}

/**
 * A comment about the whole manuscript still needs a place in the text to
 * live: selects the cursor's paragraph, or on an empty line the nearest
 * paragraph above (or below) that has text.
 */
function selectManuscriptCommentAnchor(editor: BlockNoteEditor<any, any, any>) {
  const cursor = editor.getTextCursorPosition();
  const candidates = [cursor.block];
  for (let block = cursor.prevBlock; block; block = editor.getPrevBlock(block)) candidates.push(block);
  for (let block = cursor.nextBlock; block; block = editor.getNextBlock(block)) candidates.push(block);
  const range = candidates
    .map((block) => blockTextRange(editor, block.id))
    .find((candidate) => candidate && candidate.to > candidate.from);
  const view = editor.prosemirrorView;
  if (!range || !view) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
  return true;
}

/**
 * Opens the comment composer without a text selection (slash menu). Such a
 * comment asks for changes anywhere in the manuscript.
 */
export function startCommentAtCursor(editor: BlockNoteEditor<any, any, any>) {
  const comments = editor.getExtension(CommentsExtension);
  if (!comments || !selectManuscriptCommentAnchor(editor)) return;
  manuscriptComments.add(editor);
  // Opening is deferred so the selection change above (which cancels a pending
  // comment) and the slash menu closing are both settled first.
  requestAnimationFrame(() => {
    comments.startPendingComment();
    editor.getExtension(FormattingToolbarExtension)?.store.setState(false);
  });
}

/**
 * Asks ScholarPen AI to run the built-in im-not-ai humanizer over the whole
 * manuscript (slash menu): saves the request as a comment right away.
 */
export function requestHumanizeManuscript(editor: BlockNoteEditor<any, any, any>) {
  const comments = editor.getExtension(CommentsExtension);
  if (!comments) return;
  const text = "/humanize — 원고 전체의 AI 티를 없애고 어투를 자연스럽게 다듬어 주세요 (im-not-ai).";
  // Deferred like startCommentAtCursor, so the slash menu has removed its query text first.
  requestAnimationFrame(() => {
    if (!selectManuscriptCommentAnchor(editor)) return;
    const metadata: ThreadMeta = { assignee: "ai", status: "open", requestedAt: Date.now(), scope: "document" };
    void comments.createThread({
      initialComment: { body: [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }] },
      metadata,
    });
  });
}
