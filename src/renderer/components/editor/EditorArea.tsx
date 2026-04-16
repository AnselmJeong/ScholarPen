import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsDark } from "../../main";
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
import {
  getScholarSlashMenuItems,
  getCustomHeadingSlashMenuItems,
  filterDefaultSlashMenuItems,
  getAISlashMenuItemsFixed,
} from "../../blocks/slash-menu-items";
import type { BlockNoteEditor } from "@blocknote/core";
import { AIExtension } from "@blocknote/xl-ai"; // Used for type reference in extensions array
import { en } from "@blocknote/core/locales";
import { en as aiEn } from "@blocknote/xl-ai/locales";
import "@blocknote/xl-ai/style.css";
import { createOllamaTransport, createNoOpTransport } from "../../ai/ollama-transport";
import { AIInlineEditPanel, type SelectionSnapshot } from "./AIInlineEditPanel";
import { DOIInputDialog } from "./DOIInputDialog";
import { FindReplacePanel } from "./FindReplacePanel";

type SaveStatus = "saved" | "saving" | "unsaved";

// Extract @type{citekey, ...} keys from a BibTeX string
function parseCitekeys(bibtex: string): string[] {
  const keys: string[] = [];
  const re = /@\w+\{([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bibtex)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

interface EditorAreaProps {
  project: ProjectInfo | null;
  documentFilename: string | null;
  ollamaStatus: OllamaStatus;
  onWordCountChange: (count: number) => void;
  onEditorReady: (editor: BlockNoteEditor<any, any, any> | null) => void;
  onSaveStatusChange: (status: SaveStatus) => void;
  reloadTrigger?: number;
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
  reloadTrigger,
}: EditorAreaProps) {
  const isDark = useIsDark();
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
  const saveStatusRef = useRef<SaveStatus>("saved");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [aiEditSnapshot, setAiEditSnapshot] = useState<SelectionSnapshot | null>(null);
  const [citekeys, setCitekeys] = useState<string[]>([]);
  const [doiDialogOpen, setDoiDialogOpen] = useState(false);
  const [doiLoading, setDoiLoading] = useState(false);
  const [doiError, setDoiError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);

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

  // Load citekeys from references.bib when project changes
  useEffect(() => {
    if (!project) { setCitekeys([]); return; }
    rpc.loadBibtex(project.path)
      .then((bibtex) => setCitekeys(parseCitekeys(bibtex ?? "")))
      .catch(() => setCitekeys([]));
  }, [project?.path]);

  // Load document when project or file switches
  useEffect(() => {
    if (!project) return;
    const filename = documentFilename || "manuscript.scholarpen.json";
    rpc
      .loadDocument(project.path, filename)
      .then((content) => {
        if (Array.isArray(content) && content.length > 0) {
          if (JSON.stringify(content) !== JSON.stringify(editor.document)) {
            editor.replaceBlocks(
              editor.document,
              content as Parameters<typeof editor.replaceBlocks>[1]
            );
          }
        }
      })
      .catch(console.error);
  }, [project?.path, documentFilename]);

  // Refs so the reload effect can read current project/filename without re-running on their changes
  const projectRef = useRef(project);
  const documentFilenameRef = useRef(documentFilename);
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { documentFilenameRef.current = documentFilename; }, [documentFilename]);

  // Reload from external file change — but only when the editor has no unsaved changes,
  // to prevent cursor being jumped to the end while the user is actively typing.
  useEffect(() => {
    if (reloadTrigger === 0) return; // skip initial mount
    const p = projectRef.current;
    if (!p) return;
    if (saveStatusRef.current !== "saved") return;
    const filename = documentFilenameRef.current || "manuscript.scholarpen.json";
    rpc
      .loadDocument(p.path, filename)
      .then((content) => {
        if (Array.isArray(content) && content.length > 0) {
          if (JSON.stringify(content) !== JSON.stringify(editor.document)) {
            editor.replaceBlocks(
              editor.document,
              content as Parameters<typeof editor.replaceBlocks>[1]
            );
          }
        }
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTrigger]);

  const countWords = useCallback(() => {
    const text = editor.document.map((b) => extractText(b.content)).join(" ");
    const count = text.trim() ? text.trim().split(/\s+/).length : 0;
    onWordCountChange(count);
  }, [editor, onWordCountChange]);

  const updateSaveStatus = useCallback((status: SaveStatus) => {
    saveStatusRef.current = status;
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

  // ── DOI resolution & insertion ───────────────────────────────────────────
  const handleDOISubmit = useCallback(async (doi: string) => {
    if (!project) return;
    setDoiLoading(true);
    setDoiError(null);
    try {
      const meta = await rpc.resolveDOI(doi);

      // Only fetch and update bibtex if the key isn't already loaded
      if (!citekeys.includes(meta.citekey)) {
        const existing = await rpc.loadBibtex(project.path);
        const updated = existing ? `${existing.trimEnd()}\n\n${meta.bibtex}` : meta.bibtex;
        await rpc.saveBibtex(project.path, updated);
        setCitekeys((prev) =>
          prev.includes(meta.citekey) ? prev : [...prev, meta.citekey]
        );
      }

      // Close dialog first, then restore editor focus before inserting
      setDoiDialogOpen(false);
      requestAnimationFrame(() => {
        editor.focus();
        editor.insertInlineContent([
          { type: "citation", props: { citekey: meta.citekey, locator: "" } },
        ]);
      });
    } catch (err) {
      setDoiError(
        err instanceof Error ? err.message : "Failed to resolve DOI. Check the value and try again."
      );
    } finally {
      setDoiLoading(false);
    }
  }, [editor, project]);

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
    }, 5 * 60 * 1000); // 5 minutes
  }, [editor, project, documentFilename, countWords, updateSaveStatus]);

  // Build slash menu items once; only rebuild when editor, AI, or citekeys change.
  // Kept out of getItems to avoid reconstructing all block-type arrays on every keystroke.
  const slashMenuItems = useMemo(() => {
    const scholar = getScholarSlashMenuItems(
      editor as Parameters<typeof getScholarSlashMenuItems>[0],
      () => setDoiDialogOpen(true),
    );
    const headings = getCustomHeadingSlashMenuItems(
      editor as Parameters<typeof getCustomHeadingSlashMenuItems>[0]
    );
    const defaults = filterDefaultSlashMenuItems(getDefaultReactSlashMenuItems(editor));
    const aiItems = ollamaStatus.connected ? getAISlashMenuItemsFixed(editor) : [];
    return [...scholar, ...headings, ...defaults, ...aiItems];
  }, [editor, ollamaStatus.connected]);

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: "#ffffff" }}>
        <div className="text-center" style={{ color: "#7b7e94" }}>
          <p className="text-lg mb-2" style={{ fontFamily: "Newsreader, Georgia, serif" }}>No project open</p>
          <p className="text-sm">Create or open a project from the sidebar</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative" style={{ background: "#ffffff" }}
      onKeyDown={(e) => {
        if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "f") {
          e.preventDefault();
          setFindOpen(true);
          setFindShowReplace(false);
        } else if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "h") {
          e.preventDefault();
          setFindOpen(true);
          setFindShowReplace(true);
        }
      }}
    >
      {/* Breadcrumb */}
      <div className="px-10 py-3 flex items-center gap-1.5 text-xs" style={{ color: "#6d6d8e", background: "#ffffff" }}>
        <span className="font-medium" style={{ color: "#1e1b4b" }}>{project.name}</span>
        {documentFilename && (
          <>
            <span style={{ color: "#b0aec8" }}>/</span>
            <span>{documentFilename.replace(".scholarpen.json", "")}</span>
          </>
        )}
      </div>
      <div className="flex-1 overflow-y-auto" style={{ background: "#ffffff", paddingLeft: "2.5rem", paddingRight: "2.5rem", paddingTop: "1.5rem", paddingBottom: "4rem" }}>
        {/* max-width 800px for optimal reading line length per DESIGN.md */}
        <div style={{ maxWidth: "800px", margin: "0 auto" }}>
          <BlockNoteView
            editor={editor}
            onChange={handleChange}
            theme={isDark ? "dark" : "light"}
            slashMenu={false}
            formattingToolbar={false}
          >
            <AIMenuController />
            <SuggestionMenuController
              triggerCharacter="$"
              getItems={async () => [
                {
                  title: "Inline Equation",
                  subtext: "Insert inline LaTeX equation",
                  onItemClick: () =>
                    editor.insertInlineContent([
                      { type: "inlineMath", props: { formula: "" } },
                    ]),
                },
              ]}
            />
            {/* @ → citation picker from references.bib */}
            <SuggestionMenuController
              triggerCharacter="@"
              getItems={async (query) => {
                const filtered = citekeys.filter((k) =>
                  k.toLowerCase().includes(query.toLowerCase())
                );
                if (filtered.length === 0) return [];
                return filtered.map((key) => ({
                  title: key,
                  group: "Citations",
                  icon: (
                    <span className="text-xs font-mono font-bold leading-none">
                      [@]
                    </span>
                  ),
                  subtext: "Insert inline citation",
                  onItemClick: () =>
                    editor.insertInlineContent([
                      { type: "citation", props: { citekey: key, locator: "" } },
                    ]),
                }));
              }}
            />
            {/* / → main slash menu: Scholar → Headings → other defaults → AI */}
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) => {
                if (!query) return slashMenuItems;
                return slashMenuItems.filter(
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

      {/* Find / Replace panel — absolutely positioned in top-right of editor */}
      <FindReplacePanel
        editor={editor}
        isOpen={findOpen}
        onClose={() => setFindOpen(false)}
        showReplaceInitially={findShowReplace}
      />

      {/* DOI input dialog */}
      <DOIInputDialog
        isOpen={doiDialogOpen}
        isLoading={doiLoading}
        error={doiError}
        onClose={() => { setDoiDialogOpen(false); setDoiError(null); }}
        onSubmit={handleDOISubmit}
      />

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