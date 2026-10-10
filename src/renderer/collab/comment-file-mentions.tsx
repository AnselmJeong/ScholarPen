import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { SuggestionMenu as SuggestionMenuExtension } from "@blocknote/core/extensions";
import {
  ComponentsContext, FormattingToolbar, FormattingToolbarController,
  getFormattingToolbarItems, SuggestionMenuController, useBlockNoteContext,
  useComponentsContext, useExtensionState, type ComponentProps,
} from "@blocknote/react";
import { FileText, Folder } from "lucide-react";
import { formatFileMention } from "../../shared/file-mentions";
import type { AgentMentionableFile } from "../../shared/rpc-types";
import { rpc } from "../rpc";
import type { Transaction } from "prosemirror-state";

const ProjectContext = createContext("");

function canStartMention(transaction: Transaction) {
  const { $from, empty } = transaction.selection;
  const preceding = $from.parent.textBetween(0, $from.parentOffset, "", "\uFFFC");
  return empty && (!preceding || /\s$/.test(preceding));
}

/** Override all three comment editors: new comments, replies, and edits. */
export function CommentFileMentionsProvider({ projectPath, children }: {
  projectPath: string; children: React.ReactNode;
}) {
  const components = useComponentsContext()!;
  const value = useMemo(() => ({
    ...components, Comments: { ...components.Comments, Editor: ScholarCommentEditor },
  }), [components]);
  return <ProjectContext.Provider value={projectPath}>
    <ComponentsContext.Provider value={value}>{children}</ComponentsContext.Provider>
  </ProjectContext.Provider>;
}

function CommentFormattingToolbar() {
  const items = getFormattingToolbarItems([]).filter(item => item.key !== "nestBlockButton" && item.key !== "unnestBlockButton");
  return <FormattingToolbar blockTypeSelectItems={[]}>{items}</FormattingToolbar>;
}

function ScholarCommentEditor(props: ComponentProps["Comments"]["Editor"]) {
  const projectPath = useContext(ProjectContext);
  const context = useBlockNoteContext();
  const [error, setError] = useState("");
  const files = useRef<Promise<AgentMentionableFile[]> | null>(null);
  const menuOpen = useExtensionState(SuggestionMenuExtension, {
    editor: props.editor,
    selector: state => !!state?.show && state.triggerCharacter === "@",
  });
  const getItems = useCallback(async (query: string) => {
    try {
      files.current ??= rpc.listAgentMentionableFiles(projectPath);
      const entries = await files.current;
      setError("");
      const search = query.toLocaleLowerCase();
      return entries.filter(file => file.displayPath.toLocaleLowerCase().includes(search)).map(file => ({
        title: file.name,
        subtext: file.displayPath,
        icon: file.kind === "folder" ? <Folder size={16} /> : <FileText size={16} />,
        onItemClick: () => props.editor.insertInlineContent(`${formatFileMention(file.displayPath)} `),
      }));
    } catch (cause) {
      files.current = null;
      setError(cause instanceof Error ? cause.message : "Could not load project files.");
      return [];
    }
  }, [projectPath, props.editor]);

  return <>
    <BlockNoteView
      editor={props.editor} className={props.className} editable={props.editable}
      autoFocus={props.autoFocus} theme={context?.colorSchemePreference}
      sideMenu={false} slashMenu={false} tableHandles={false} filePanel={false}
      formattingToolbar={false} comments={false}
      data-file-mention-open={menuOpen ? "true" : undefined}
      onKeyDownCapture={event => {
        // Let the browser finish Korean/Japanese composition without letting
        // Enter select a suggestion or split the comment in ProseMirror.
        if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.stopPropagation();
      }}
      onFocus={() => { files.current = null; props.onFocus?.(); }} onBlur={props.onBlur}
    >
      <FormattingToolbarController formattingToolbar={CommentFormattingToolbar} />
      {props.editable && <SuggestionMenuController triggerCharacter="@" getItems={getItems} shouldOpen={canStartMention} />}
    </BlockNoteView>
    {props.editable && <div className="px-3 pb-1 text-xs text-muted-foreground" role={error ? "alert" : undefined}>
      {error || "@ 파일·폴더 참조 · ↑↓ 탐색 · Enter 선택 · Esc 닫기"}
    </div>}
  </>;
}

/** Let the suggestion menu consume Enter before the surrounding card submits. */
export function hasOpenFileMentionMenu(target: EventTarget) {
  return target instanceof Element && !!target.closest('[data-file-mention-open="true"]');
}
