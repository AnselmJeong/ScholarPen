import React, { useCallback, useEffect, useRef } from "react";
import {
  useCreateBlockNote,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  FormattingToolbar,
  FormattingToolbarController,
  BlockTypeSelect,
  BasicTextStyleButton,
  TextAlignButton,
  ColorStyleButton,
  NestBlockButton,
  UnnestBlockButton,
  CreateLinkButton,
} from "@blocknote/react";
import { AIToolbarButton, AIMenuController } from "@blocknote/xl-ai";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { rpc } from "../../rpc";
import type { OllamaStatus, ProjectInfo } from "../../../shared/rpc-types";
import { scholarSchema } from "../../blocks/schema";
import { getScholarSlashMenuItems, getAISlashMenuItemsFixed } from "../../blocks/slash-menu-items";
import type { BlockNoteEditor } from "@blocknote/core";
import { AIExtension } from "@blocknote/xl-ai"; // Used for type reference in extensions array
import { en } from "@blocknote/core/locales";
import { en as aiEn } from "@blocknote/xl-ai/locales";
import "@blocknote/xl-ai/style.css";
import { createOllamaTransport, createNoOpTransport } from "../../ai/ollama-transport";

interface EditorAreaProps {
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus;
  onWordCountChange: (count: number) => void;
  onEditorReady: (editor: BlockNoteEditor<any, any, any> | null) => void;
}

function extractText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  if (Array.isArray(content)) return content.map(extractText).join(" ");
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (Array.isArray(obj.content)) return extractText(obj.content);
  return "";
}

export function EditorArea({
  project,
  ollamaStatus,
  onWordCountChange,
  onEditorReady,
}: EditorAreaProps) {
  const editor = useCreateBlockNote({
    schema: scholarSchema,
    dictionary: {
      ...en,
      ai: aiEn,
    },
    extensions: [
      AIExtension({
        transport: ollamaStatus.connected
          ? createOllamaTransport(ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "qwen3.5:cloud")
          : createNoOpTransport(),
      }),
    ],
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notify parent when editor mounts/unmounts.
  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor]);

  // Hot-swap the AIExtension transport whenever Ollama status changes.
  //
  // useCreateBlockNote is memoized with [] deps, so it always returns the same
  // editor instance regardless of ollamaStatus.  The AIExtension stores its
  // options in a TanStack Store (extension.options) — calling setState() on it
  // updates the transport used by *future* invokeAI calls without recreating
  // the editor or losing document content.
  //
  // We also call closeAIMenu() to reset the cached `chat` object (variable `i`
  // inside the AIExtension closure).  Once `i` is set with a broken transport
  // it is reused on every call until the menu is explicitly closed.  Calling
  // closeAIMenu() when the menu is already closed is a safe no-op for the UI
  // state; the only side-effect is `.focus()` on the editor, which is fine.
  useEffect(() => {
    const aiExt = editor.getExtension("ai") as any;
    console.log("[EditorArea] AIExtension initialized:", !!aiExt);
    console.log("[EditorArea] Ollama connected:", ollamaStatus.connected);
    console.log("[EditorArea] Ollama models:", ollamaStatus.models);

    if (!aiExt?.options?.setState) return;

    const transport = ollamaStatus.connected
      ? createOllamaTransport(
          ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "qwen2.5:latest"
        )
      : createNoOpTransport();

    // 1. Update the TanStack Store so the next fresh chat uses this transport.
    aiExt.options.setState((prev: Record<string, unknown>) => ({
      ...prev,
      transport,
    }));

    // 2. Reset the cached chat object (`i`) so the next AI invocation creates
    //    a fresh Chat with the new transport instead of reusing a stale one.
    //    Only do this when no AI generation is currently in progress.
    const menuState = aiExt.store?.state?.aiMenuState;
    if (menuState === "closed" || menuState == null) {
      aiExt.closeAIMenu?.();
    }
  }, [editor, ollamaStatus.connected, ollamaStatus.activeModel]);

  useEffect(() => {
    if (!project) return;
    rpc
      .loadManuscript(project.path)
      .then((content) => {
        if (Array.isArray(content) && content.length > 0) {
          editor.replaceBlocks(
            editor.document,
            content as Parameters<typeof editor.replaceBlocks>[1]
          );
        }
      })
      .catch(console.error);
  }, [project?.path]);

  const countWords = useCallback(() => {
    const text = editor.document.map((b) => extractText(b.content)).join(" ");
    const count = text.trim() ? text.trim().split(/\s+/).length : 0;
    onWordCountChange(count);
  }, [editor, onWordCountChange]);

  const handleChange = useCallback(() => {
    countWords();
    if (!project) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      rpc.saveManuscript(project.path, editor.document).catch(console.error);
    }, 2000);
  }, [editor, project, countWords]);

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center text-gray-400">
          <p className="text-lg mb-2">No project open</p>
          <p className="text-sm">Create or open a project from the sidebar</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      <div className="px-6 py-2 border-b border-gray-100 text-sm text-gray-500 font-medium">
        {project.name}
      </div>
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-3xl mx-auto">
          <BlockNoteView
            editor={editor}
            onChange={handleChange}
            theme="light"
            slashMenu={false}
            formattingToolbar={false}
          >
            <AIMenuController />
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) => {
                const defaults = getDefaultReactSlashMenuItems(editor);
                const scholar = getScholarSlashMenuItems(
                  editor as Parameters<typeof getScholarSlashMenuItems>[0]
                );
                // Use fixed AI slash menu items that uses string key lookup
                const aiItems = ollamaStatus.connected ? getAISlashMenuItemsFixed(editor) : [];
                console.log("[EditorArea] Slash menu - AI items count:", aiItems.length);
                return [...defaults, ...scholar, ...aiItems].filter(
                  (item) =>
                    item.title.toLowerCase().includes(query.toLowerCase()) ||
                    (item.aliases ?? []).some((a) =>
                      a.toLowerCase().includes(query.toLowerCase())
                    )
                );
              }}
            />
            <FormattingToolbarController
              formattingToolbar={() => (
                <FormattingToolbar>
                  {ollamaStatus.connected && <AIToolbarButton key="aiToolbarButton" />}
                  <BlockTypeSelect key="blockTypeSelect" />
                  <BasicTextStyleButton basicTextStyle="bold" key="boldStyleButton" />
                  <BasicTextStyleButton basicTextStyle="italic" key="italicStyleButton" />
                  <BasicTextStyleButton basicTextStyle="underline" key="underlineStyleButton" />
                  <BasicTextStyleButton basicTextStyle="strike" key="strikeStyleButton" />
                  <BasicTextStyleButton basicTextStyle="code" key="codeStyleButton" />
                  <TextAlignButton textAlignment="left" key="textAlignLeftButton" />
                  <TextAlignButton textAlignment="center" key="textAlignCenterButton" />
                  <TextAlignButton textAlignment="right" key="textAlignRightButton" />
                  <ColorStyleButton key="colorStyleButton" />
                  <NestBlockButton key="nestBlockButton" />
                  <UnnestBlockButton key="unnestBlockButton" />
                  <CreateLinkButton key="createLinkButton" />
                </FormattingToolbar>
              )}
            />
          </BlockNoteView>
        </div>
      </div>
    </div>
  );
}
