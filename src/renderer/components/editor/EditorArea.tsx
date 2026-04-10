import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { Sparkles } from "lucide-react";
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
import { AIInlineEditPanel, type SelectionSnapshot } from "./AIInlineEditPanel";

type SaveStatus = "saved" | "saving" | "unsaved";

interface EditorAreaProps {
  project: ProjectInfo | null;
  documentFilename: string | null;
  ollamaStatus: OllamaStatus;
  onWordCountChange: (count: number) => void;
  onEditorReady: (editor: BlockNoteEditor<any, any, any> | null) => void;
  onSaveStatusChange: (status: SaveStatus) => void;
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
  documentFilename,
  ollamaStatus,
  onWordCountChange,
  onEditorReady,
  onSaveStatusChange,
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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [aiEditSnapshot, setAiEditSnapshot] = useState<SelectionSnapshot | null>(null);

  // Notify parent when editor mounts/unmounts.
  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor]);

  // Hot-swap the AIExtension transport whenever Ollama status changes.
  useEffect(() => {
    const aiExt = editor.getExtension("ai") as any;
    if (!aiExt?.options?.setState) return;

    const transport = ollamaStatus.connected
      ? createOllamaTransport(
          ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "qwen2.5:latest"
        )
      : createNoOpTransport();

    aiExt.options.setState((prev: Record<string, unknown>) => ({
      ...prev,
      transport,
    }));

    const menuState = aiExt.store?.state?.aiMenuState;
    if (menuState === "closed" || menuState == null) {
      aiExt.closeAIMenu?.();
    }
  }, [editor, ollamaStatus.connected, ollamaStatus.activeModel]);

  // Load document when project or document changes
  useEffect(() => {
    if (!project) return;
    const filename = documentFilename || "manuscript.scholarpen.json";
    rpc
      .loadDocument(project.path, filename)
      .then((content) => {
        if (Array.isArray(content) && content.length > 0) {
          editor.replaceBlocks(
            editor.document,
            content as Parameters<typeof editor.replaceBlocks>[1]
          );
        }
      })
      .catch(console.error);
  }, [project?.path, documentFilename]);

  const countWords = useCallback(() => {
    const text = editor.document.map((b) => extractText(b.content)).join(" ");
    const count = text.trim() ? text.trim().split(/\s+/).length : 0;
    onWordCountChange(count);
  }, [editor, onWordCountChange]);

  const updateSaveStatus = useCallback((status: SaveStatus) => {
    setSaveStatus(status);
    onSaveStatusChange(status);
  }, [onSaveStatusChange]);

  // Immediate save (for Cmd+S / menu action)
  const saveNow = useCallback(() => {
    if (!project) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const filename = documentFilename || "manuscript.scholarpen.json";
    updateSaveStatus("saving");
    rpc.saveDocument(project.path, filename, editor.document)
      .then(() => updateSaveStatus("saved"))
      .catch((err) => {
        console.error("Save failed:", err);
        updateSaveStatus("unsaved");
      });
  }, [editor, project, documentFilename, updateSaveStatus]);

  // Expose saveNow for external callers (e.g., menu actions)
  useEffect(() => {
    (editor as any).__scholarpenSaveNow = saveNow;
  }, [editor, saveNow]);

  // ── AI inline edit (selection-scoped) ────────────────────────────────────
  // Called from the custom AI Edit button in the FormattingToolbar.
  // We snapshot the ProseMirror positions + viewport coords BEFORE the button
  // click might shift focus away from the editor.
  const handleAIEditActivate = useCallback(() => {
    const view = (editor as any).prosemirrorView;
    if (!view) return;
    const { from, to } = view.state.selection;
    const selectedText = editor.getSelectedText();
    if (!selectedText.trim()) return;

    // Get screen coordinates of the selection start
    const coords = view.coordsAtPos(from);
    const coordsEnd = view.coordsAtPos(to);
    setAiEditSnapshot({
      from,
      to,
      selectedText,
      top: coords.top,
      bottom: coordsEnd.bottom,
      left: coords.left,
    });
  }, [editor]);

  // Called when the user clicks Accept in the AI panel.
  // Replaces ONLY the saved from..to range — the rest of the block is untouched.
  const handleAIEditAccept = useCallback(
    (from: number, to: number, newText: string) => {
      const view = (editor as any).prosemirrorView;
      if (!view) return;
      const { state } = view;
      const tr = state.tr.replaceWith(from, to, state.schema.text(newText));
      view.dispatch(tr);
      view.focus();
      setAiEditSnapshot(null);
    },
    [editor]
  );

  const handleChange = useCallback(() => {
    countWords();
    if (!project) return;
    updateSaveStatus("unsaved");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const filename = documentFilename || "manuscript.scholarpen.json";
      updateSaveStatus("saving");
      rpc.saveDocument(project.path, filename, editor.document)
        .then(() => updateSaveStatus("saved"))
        .catch((err) => {
          console.error("Auto-save failed:", err);
          updateSaveStatus("unsaved");
        });
    }, 2000);
  }, [editor, project, documentFilename, countWords, updateSaveStatus]);

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
        {project.name}{documentFilename ? ` / ${documentFilename.replace(".scholarpen.json", "")}` : ""}
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
                const aiItems = ollamaStatus.connected ? getAISlashMenuItemsFixed(editor) : [];
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
                  {/* Block-level AI (xl-ai) */}
                  {ollamaStatus.connected && <AIToolbarButton key="aiToolbarButton" />}

                  {/* Selection-scoped AI edit button */}
                  {ollamaStatus.connected && (
                    <button
                      key="aiInlineEditButton"
                      onMouseDown={(e) => {
                        // Prevent the editor from losing its selection
                        e.preventDefault();
                        handleAIEditActivate();
                      }}
                      title="Edit selection with AI"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        fontSize: 12,
                        fontWeight: 500,
                        borderRadius: 6,
                        border: "1px solid hsl(var(--border))",
                        background: "hsl(var(--background))",
                        color: "hsl(var(--primary))",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Sparkles style={{ width: 12, height: 12 }} />
                      Edit
                    </button>
                  )}

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

      {/* AI inline edit panel — rendered via portal, independent of toolbar lifecycle */}
      {aiEditSnapshot && (
        <AIInlineEditPanel
          snapshot={aiEditSnapshot}
          model={ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "qwen3.5:cloud"}
          onAccept={handleAIEditAccept}
          onClose={() => setAiEditSnapshot(null)}
        />
      )}
    </div>
  );
}