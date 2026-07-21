import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseBibtexCitekeys, parseBibtexDOIMap, parseBibtexEntries } from "../../../shared/bibtex-utils";
import { useIsDark } from "../../main";
import {
  useCreateBlockNote,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  FormattingToolbar,
  FormattingToolbarController,
  BasicTextStyleButton,
  TextAlignButton,
  ColorStyleButton,
  NestBlockButton,
  UnnestBlockButton,
  CreateLinkButton,
  DragHandleMenu,
  RemoveBlockItem,
  BlockColorsItem,
  useBlockNoteEditor,
  useComponentsContext,
  SideMenu,
  SideMenuController,
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
import {
  isSameProtectedSlice,
  protectSelectionSlice,
  restoreProtectedSelection,
} from "./ai-inline-edit-protection";
import { DOIInputDialog } from "./DOIInputDialog";
import { FindReplacePanel } from "./FindReplacePanel";
import { setCitationHoverMetadata, type CitationHoverMetadata } from "../../blocks/citation-inline";

type SaveStatus = "saved" | "saving" | "unsaved";

// Extract @type{citekey, ...} keys from a BibTeX string
function parseCitekeys(bibtex: string): string[] {
  return parseBibtexCitekeys(bibtex);
}

function cleanBibtexText(value: string | undefined): string {
  return (value ?? "")
    .replace(/[{}]/g, "")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstAuthorName(authorField: string | undefined): string {
  const first = cleanBibtexText(authorField).split(/\s+and\s+/i)[0] ?? "";
  if (first.includes(",")) return first.split(",")[0].trim();
  const parts = first.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : first;
}

function buildCitationHoverMetadata(bibtex: string): Map<string, CitationHoverMetadata> {
  const metadata = new Map<string, CitationHoverMetadata>();
  for (const entry of parseBibtexEntries(bibtex).entries) {
    const firstAuthor = firstAuthorName(entry.fields.author);
    const year = cleanBibtexText(entry.fields.year);
    const title = cleanBibtexText(entry.fields.title);
    if (firstAuthor || year || title) {
      metadata.set(entry.citekey, {
        firstAuthor: firstAuthor || entry.citekey,
        year: year || "n.d.",
        title: title || "Untitled",
      });
    }
  }
  return metadata;
}

interface EditorAreaProps {
  project: ProjectInfo | null;
  documentFilename: string | null;
  ollamaStatus: OllamaStatus;
  initialScrollTop?: number;
  onWordCountChange: (count: number) => void;
  onEditorReady: (editor: BlockNoteEditor<any, any, any> | null) => void;
  onScrollPositionChange?: (scrollTop: number) => void;
  onSaveStatusChange: (status: SaveStatus) => void;
  reloadTrigger?: number;
  bibReloadTrigger?: number;
}

/** Block type submenu for the drag handle popup */
const BLOCK_TYPE_ITEMS = [
  { type: "paragraph",       label: "Paragraph",       props: {} },
  { type: "heading",         label: "Heading 1",        props: { level: 1 } },
  { type: "heading",         label: "Heading 2",        props: { level: 2 } },
  { type: "heading",         label: "Heading 3",        props: { level: 3 } },
  { type: "bulletListItem",  label: "Bullet List",      props: {} },
  { type: "numberedListItem",label: "Numbered List",    props: {} },
  { type: "checkListItem",   label: "Check List",       props: {} },
  { type: "quote",           label: "Quote",            props: {} },
] as const;

function BlockTypeDragItem() {
  const editor = useBlockNoteEditor();
  const components = useComponentsContext();
  if (!components) return null;
  return (
    <components.Generic.Menu.Root position="right" sub={true}>
      <components.Generic.Menu.Trigger sub={true}>
        <components.Generic.Menu.Item className="bn-menu-item" subTrigger={true}>
          Turn Into
        </components.Generic.Menu.Item>
      </components.Generic.Menu.Trigger>
      <components.Generic.Menu.Dropdown sub={true} className="bn-menu-dropdown">
        {BLOCK_TYPE_ITEMS.map(({ type, label, props: blockProps }) => (
          <components.Generic.Menu.Item
            key={label}
            className="bn-menu-item"
            onClick={() => {
              // Read the hovered block from the side menu store at click time
              const sideMenuExt = (editor as any).getExtension("sideMenu");
              const block = sideMenuExt?.store?.state?.block
                ?? editor.getTextCursorPosition().block;
              editor.updateBlock(block, { type: type as any, props: blockProps as any });
              editor.setTextCursorPosition(block.id, "end");
              editor.focus();
            }}
          >
            {label}
          </components.Generic.Menu.Item>
        ))}
      </components.Generic.Menu.Dropdown>
    </components.Generic.Menu.Root>
  );
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
  initialScrollTop = 0,
  onWordCountChange,
  onEditorReady,
  onScrollPositionChange,
  onSaveStatusChange,
  reloadTrigger,
  bibReloadTrigger,
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
          ? createOllamaTransport(ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "qwen3.5:397b")
          : createNoOpTransport(),
      }),
    ],
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveStatusRef = useRef<SaveStatus>("saved");
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const dirtyRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const inFlightSaveCountRef = useRef(0);
  const suppressSaveUntilRef = useRef(0);
  const pendingExternalReloadRef = useRef(false);
  const pendingReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUserEditAtRef = useRef(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [aiEditSnapshot, setAiEditSnapshot] = useState<SelectionSnapshot | null>(null);
  const [citekeys, setCitekeys] = useState<string[]>([]);
  const citekeysRef = useRef<string[]>([]);
  const [doiDialogOpen, setDoiDialogOpen] = useState(false);
  const [doiLoading, setDoiLoading] = useState(false);
  const [doiError, setDoiError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasRestoredScrollRef = useRef(false);

  const restoreScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || hasRestoredScrollRef.current) return;
    hasRestoredScrollRef.current = true;
    const top = Math.max(0, initialScrollTop);
    requestAnimationFrame(() => {
      container.scrollTop = top;
      requestAnimationFrame(() => {
        container.scrollTop = top;
      });
    });
  }, [initialScrollTop]);

  const replaceDocumentWithoutSaving = useCallback((content: Parameters<typeof editor.replaceBlocks>[1]) => {
    suppressSaveUntilRef.current = Date.now() + 500;
    editor.replaceBlocks(editor.document, content);
  }, [editor]);

  const hasLocalChangesPending = useCallback(() => {
    return (
      saveTimerRef.current !== null ||
      inFlightSaveCountRef.current > 0 ||
      dirtyRevisionRef.current !== savedRevisionRef.current
    );
  }, []);

  const isRecentlyEdited = useCallback(() => {
    return Date.now() - lastUserEditAtRef.current < 1500;
  }, []);

  const snapshotDocument = useCallback(() => {
    return JSON.parse(JSON.stringify(editor.document));
  }, [editor]);

  const applyBibtexState = useCallback((bibtex: string) => {
    setCitekeys(parseCitekeys(bibtex));
    setCitationHoverMetadata(buildCitationHoverMetadata(bibtex));
  }, []);

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
      ? createOllamaTransport(ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "qwen3.5:397b")
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
    if (!project) {
      setCitekeys([]);
      setCitationHoverMetadata(new Map());
      return;
    }
    rpc.loadBibtex(project.path)
      .then((bibtex) => applyBibtexState(bibtex ?? ""))
      .catch(() => {
        setCitekeys([]);
        setCitationHoverMetadata(new Map());
      });
  }, [project?.path, bibReloadTrigger, applyBibtexState]);

  useEffect(() => {
    citekeysRef.current = citekeys;
  }, [citekeys]);

  // Load document when project or file switches
  useEffect(() => {
    hasRestoredScrollRef.current = false;
    if (!project) return;
    const filename = documentFilename || "manuscript.scholarpen.json";
    rpc
      .loadDocument(project.path, filename)
      .then((content) => {
        if (Array.isArray(content) && content.length > 0) {
          if (JSON.stringify(content) !== JSON.stringify(editor.document)) {
            replaceDocumentWithoutSaving(content as Parameters<typeof editor.replaceBlocks>[1]);
          }
        }
        restoreScrollPosition();
      })
      .catch(console.error);
  }, [project?.path, documentFilename, replaceDocumentWithoutSaving, restoreScrollPosition]);

  useEffect(() => {
    restoreScrollPosition();
  }, [restoreScrollPosition]);

  // Refs so the reload effect can read current project/filename without re-running on their changes
  const projectRef = useRef(project);
  const documentFilenameRef = useRef(documentFilename);
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { documentFilenameRef.current = documentFilename; }, [documentFilename]);

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

  const processPendingExternalReload = useCallback(() => {
    if (!pendingExternalReloadRef.current) return;
    if (hasLocalChangesPending() || isRecentlyEdited()) {
      if (!pendingReloadTimerRef.current) {
        pendingReloadTimerRef.current = setTimeout(() => {
          pendingReloadTimerRef.current = null;
          processPendingExternalReload();
        }, 750);
      }
      return;
    }

    const p = projectRef.current;
    if (!p) return;
    pendingExternalReloadRef.current = false;
    const filename = documentFilenameRef.current || "manuscript.scholarpen.json";
    rpc
      .loadDocument(p.path, filename)
      .then((content) => {
        if (Array.isArray(content) && content.length > 0) {
          if (JSON.stringify(content) !== JSON.stringify(editor.document)) {
            replaceDocumentWithoutSaving(content as Parameters<typeof editor.replaceBlocks>[1]);
          }
        }
      })
      .catch(console.error);
  }, [editor, hasLocalChangesPending, isRecentlyEdited, replaceDocumentWithoutSaving]);

  // Reload from external file change only when local edits are fully settled.
  // Whole-document replacement can move the ProseMirror selection, so never do it
  // while a user edit is pending, saving, or very recent.
  useEffect(() => {
    if (reloadTrigger === 0) return; // skip initial mount
    const p = projectRef.current;
    if (!p) return;
    if (hasLocalChangesPending() || isRecentlyEdited()) {
      pendingExternalReloadRef.current = true;
      processPendingExternalReload();
      return;
    }
    const filename = documentFilenameRef.current || "manuscript.scholarpen.json";
    rpc
      .loadDocument(p.path, filename)
      .then((content) => {
        if (Array.isArray(content) && content.length > 0) {
          if (JSON.stringify(content) !== JSON.stringify(editor.document)) {
            replaceDocumentWithoutSaving(content as Parameters<typeof editor.replaceBlocks>[1]);
          }
        }
      })
      .catch(console.error);
  }, [editor, reloadTrigger, hasLocalChangesPending, isRecentlyEdited, processPendingExternalReload, replaceDocumentWithoutSaving]);

  const enqueueSave = useCallback((filename: string, getContent: () => unknown, revision: number) => {
    if (!project) return Promise.resolve();
    inFlightSaveCountRef.current += 1;
    updateSaveStatus("saving");

    const run = saveChainRef.current
      .catch(() => undefined)
      .then(() => {
        if (revision < dirtyRevisionRef.current) {
          return "skipped-stale" as const;
        }
        return rpc.saveDocument(project.path, filename, getContent()).then(() => "saved" as const);
      })
      .then(() => {
        if (revision <= dirtyRevisionRef.current) {
          savedRevisionRef.current = Math.max(savedRevisionRef.current, revision);
        }
        if (
          dirtyRevisionRef.current === savedRevisionRef.current &&
          saveTimerRef.current === null &&
          inFlightSaveCountRef.current === 0
        ) {
          updateSaveStatus("saved");
          processPendingExternalReload();
        } else if (saveTimerRef.current === null && inFlightSaveCountRef.current === 0) {
          updateSaveStatus("unsaved");
        }
      })
      .catch((err) => {
        console.error("Save failed:", err);
        updateSaveStatus("unsaved");
      })
      .finally(() => {
        inFlightSaveCountRef.current = Math.max(0, inFlightSaveCountRef.current - 1);
        if (
          dirtyRevisionRef.current === savedRevisionRef.current &&
          saveTimerRef.current === null &&
          inFlightSaveCountRef.current === 0
        ) {
          updateSaveStatus("saved");
          processPendingExternalReload();
        } else if (saveTimerRef.current === null && inFlightSaveCountRef.current === 0) {
          updateSaveStatus("unsaved");
        }
      });

    saveChainRef.current = run;
    return run;
  }, [project, updateSaveStatus, processPendingExternalReload]);

  // Immediate save (for Cmd+S / menu action)
  const saveNow = useCallback(() => {
    if (!project) return;
    if (saveStatusRef.current === "saved" && !saveTimerRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const filename = documentFilename || "manuscript.scholarpen.json";
    enqueueSave(filename, snapshotDocument, dirtyRevisionRef.current);
  }, [project, documentFilename, enqueueSave, snapshotDocument]);

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

      // Always read fresh from disk to avoid stale-state race conditions.
      // Check by DOI first (catches same paper with different citekeys),
      // then fall back to citekey check.
      const existing = await rpc.loadBibtex(project.path);
      const doiMap = parseBibtexDOIMap(existing ?? "");
      const normalizedDOI = meta.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//i, "");
      const existingCitekey = doiMap.get(normalizedDOI);
      const effectiveCitekey = existingCitekey ?? meta.citekey;

      if (!existingCitekey && !parseBibtexCitekeys(existing ?? "").includes(meta.citekey)) {
        if (!meta.bibtex.trim()) {
          throw new Error(`Resolved DOI ${meta.doi} but no BibTeX entry was returned.`);
        }
        const updated = existing ? `${existing.trimEnd()}\n\n${meta.bibtex}` : meta.bibtex;
        await rpc.saveBibtex(project.path, updated);
        const saved = await rpc.loadBibtex(project.path);
        if (!parseBibtexCitekeys(saved ?? "").includes(meta.citekey)) {
          throw new Error(`Could not verify '${meta.citekey}' in references.bib after saving.`);
        }
        applyBibtexState(saved ?? "");
      }

      // Close dialog first, then restore editor focus before inserting
      setDoiDialogOpen(false);
      requestAnimationFrame(() => {
        editor.focus();
        editor.insertInlineContent([
          { type: "citation", props: { citekey: effectiveCitekey, locator: "" } },
        ]);
      });
    } catch (err) {
      setDoiError(
        err instanceof Error ? err.message : "Failed to resolve DOI. Check the value and try again."
      );
    } finally {
      setDoiLoading(false);
    }
  }, [applyBibtexState, editor, project]);

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
    const protection = protectSelectionSlice(view.state.doc.slice(from, to), selectedText);

    // Get screen coordinates of the selection start
    const coords = view.coordsAtPos(from);
    const coordsEnd = view.coordsAtPos(to);
    setAiEditSnapshot({
      from,
      to,
      selectedText,
      protection,
      top: coords.top,
      bottom: coordsEnd.bottom,
      left: coords.left,
    });
  }, [editor]);

  // Called when the user clicks Accept in the AI panel. Rebuild the saved
  // ProseMirror Slice so its marks, citations, math, footnotes, and block
  // structure remain byte-for-byte structural equivalents; only text changes.
  const handleAIEditAccept = useCallback(
    (snapshot: SelectionSnapshot, newText: string) => {
      const view = (editor as any).prosemirrorView;
      if (!view) return "The editor is unavailable. The document was not modified.";
      const { state } = view;

      if (!isSameProtectedSlice(state.doc.slice(snapshot.from, snapshot.to), snapshot.protection)) {
        return "The selected document content changed while AI was writing. Retry from a fresh selection; the document was not modified.";
      }

      try {
        const replacement = restoreProtectedSelection(state.schema, snapshot.protection, newText);
        view.dispatch(state.tr.replace(snapshot.from, snapshot.to, replacement).scrollIntoView());
        view.focus();
        setAiEditSnapshot(null);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "The AI response could not be applied safely.";
      }
    },
    [editor]
  );

  const handleChange = useCallback(() => {
    countWords();
    if (Date.now() < suppressSaveUntilRef.current) return;
    if (!project) return;
    dirtyRevisionRef.current += 1;
    lastUserEditAtRef.current = Date.now();
    updateSaveStatus("unsaved");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const filename = documentFilename || "manuscript.scholarpen.json";
      saveTimerRef.current = null;
      enqueueSave(filename, snapshotDocument, dirtyRevisionRef.current);
    }, 2 * 1000); // 2 seconds
  }, [project, documentFilename, countWords, updateSaveStatus, enqueueSave, snapshotDocument]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (pendingReloadTimerRef.current) {
        clearTimeout(pendingReloadTimerRef.current);
        pendingReloadTimerRef.current = null;
      }
    };
  }, []);

  // Flush any pending save immediately when the window loses focus.
  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current && project) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const filename = documentFilename || "manuscript.scholarpen.json";
        enqueueSave(filename, snapshotDocument, dirtyRevisionRef.current);
      }
    };
    const handler = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [project, documentFilename, enqueueSave, snapshotDocument]);

  useEffect(() => {
    return () => {
      const top = scrollContainerRef.current?.scrollTop;
      if (top !== undefined) onScrollPositionChange?.(top);
    };
  }, [onScrollPositionChange]);

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
      <div className="flex-1 flex items-center justify-center" style={{ background: "hsl(var(--background))" }}>
        <div className="text-center" style={{ color: "var(--scholar-muted)" }}>
          <p className="text-lg mb-2" style={{ fontFamily: "Newsreader, Georgia, serif" }}>No project open</p>
          <p className="text-sm">Create or open a project from the sidebar</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative" style={{ background: "hsl(var(--background))" }}
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
      <div className="px-10 py-3 flex items-center gap-1.5 text-xs" style={{ color: "var(--scholar-muted)", background: "hsl(var(--background))" }}>
        <span className="font-medium" style={{ color: "var(--scholar-text)" }}>{project.name}</span>
        {documentFilename && (
          <>
            <span style={{ color: "var(--scholar-muted)" }}>/</span>
            <span>{documentFilename.replace(".scholarpen.json", "")}</span>
          </>
        )}
      </div>
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto"
        style={{ background: "hsl(var(--background))", paddingLeft: "2.5rem", paddingRight: "2.5rem", paddingTop: "1.5rem", paddingBottom: "4rem" }}
        onScroll={(event) => onScrollPositionChange?.(event.currentTarget.scrollTop)}
      >
        {/* max-width 800px for optimal reading line length per DESIGN.md */}
        <div style={{ maxWidth: "800px", margin: "0 auto" }}>
          <BlockNoteView
            editor={editor}
            onChange={handleChange}
            theme={isDark ? "dark" : "light"}
            slashMenu={false}
            formattingToolbar={false}
          >
            <SideMenuController
              sideMenu={() => (
                <SideMenu
                  dragHandleMenu={(props) => (
                    <DragHandleMenu {...props}>
                      <BlockTypeDragItem />
                      <BlockColorsItem {...props}>Colors</BlockColorsItem>
                      <RemoveBlockItem {...props}>Delete</RemoveBlockItem>
                    </DragHandleMenu>
                  )}
                />
              )}
            />
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
                const filtered = citekeysRef.current.filter((k) =>
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
        scrollContainerRef={scrollContainerRef}
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
          model={ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "qwen3.5:397b"}
          onAccept={handleAIEditAccept}
          onClose={() => setAiEditSnapshot(null)}
        />
      )}
    </div>
  );
}
