import { snapshotActiveDocument } from "@shared/active-document-context";
import type { ActiveDocumentContext } from "@shared/rpc-types";
import type { DocumentFindRequest } from "../../utils/editor-text-find";
import { documentRelativeFilename, editingProject } from "../../utils/document-tree";
import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { EditorArea } from "./EditorArea";
import { acceptedDocument, listChangeSets } from "../../collab/suggestions";
import { FileViewer } from "./FileViewer";
import { TabBar } from "./TabBar";
import { PaneToggle } from "./PaneToggle";
import { setOutlineVisible, useOutlineVisibility } from "./outline-visibility";
import type { FileNode, ProjectInfo, OllamaStatus } from "@shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";
import type { DeepenAnalysisRequest } from "../../ai/deepen-analysis";
import type { FindCitationRequest } from "../../ai/find-citation";
import type { CitationCheckRequest } from "../../ai/check-citations";

// ── Types ──────────────────────────────────────────────────────────────────

type SaveStatus = "saved" | "saving" | "unsaved";
type PaneId = "left" | "right";

export interface EditorTab {
  id: string;
  file: FileNode;
}

interface PaneState {
  tabs: EditorTab[];
  activeTabId: string | null;
}

export interface EditorPaneGroupHandle {
  openFile: (file: FileNode) => void;
  saveActiveEditor: () => void;
  prepareReview: () => Promise<void>;
  prepareFileDeletion: (filePath: string) => Promise<() => void>;
  closeFileByPath: (filePath: string) => void;
  getDocumentSnapshot: (filePath: string) => unknown[] | null;
  getActiveDocumentContext: () => ActiveDocumentContext | undefined;
  openProjectFindReplace: () => boolean;
}

interface EditorPaneGroupProps {
  originalPane?: React.ReactNode;
  responsePane?: React.ReactNode;
  revisionView?: "manuscript" | "response";
  onRevisionViewChange?: (view: "manuscript" | "response") => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus;
  reloadTrigger: number;
  bibReloadTrigger: number;
  onActiveFileChange: (file: FileNode | null, docFilename: string | null) => void;
  onActiveEditorChange: (editor: BlockNoteEditor<any, any, any> | null) => void;
  onSaveStatusChange: (status: SaveStatus) => void;
  onBibtexSaved: () => void;
  onDeepenAnalysis: (
    request: DeepenAnalysisRequest,
    applyRevision: (protectedRevision: string | null) => string | null,
  ) => void;
  onFindCitation: (request: FindCitationRequest) => void;
  onCheckCitations: (
    request: CitationCheckRequest,
    applyRevision: (protectedRevision: string | null) => string | null,
  ) => void;
  onReviewChanges: () => void;
}

// ── Drag tracking (outside React — never causes stale closures) ────────────

interface DragTrack {
  tabId: string;
  paneId: PaneId;
  startX: number;
  startY: number;
  active: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export const EditorPaneGroup = forwardRef<EditorPaneGroupHandle, EditorPaneGroupProps>(
  function EditorPaneGroup(
    {
      originalPane,
      responsePane,
      revisionView = "manuscript",
      onRevisionViewChange,
      filesOpen,
      onToggleFiles,
      project,
      ollamaStatus,
      reloadTrigger,
      bibReloadTrigger,
      onActiveFileChange,
      onActiveEditorChange,
      onSaveStatusChange,
      onBibtexSaved,
      onDeepenAnalysis,
      onFindCitation,
      onCheckCitations,
      onReviewChanges,
    },
    ref
  ) {
    const [leftPane, setLeftPane] = useState<PaneState>({ tabs: [], activeTabId: null });
    const [rightPane, setRightPane] = useState<PaneState | null>(null);
    const [focusedPane, setFocusedPane] = useState<PaneId>("left");
    const [findRequests, setFindRequests] = useState<Record<string, DocumentFindRequest>>({});
    const [splitRatio, setSplitRatio] = useState(50);
    const outlineVisible = useOutlineVisibility();
    const comparing = Boolean(originalPane);
    useEffect(() => { if (comparing) setOutlineVisible(false); }, [comparing]);

    // Drag-to-split state
    const [isDragging, setIsDragging] = useState(false);
    const [dropSide, setDropSide] = useState<"left" | "right" | null>(null);

    // Always-current refs for use in callbacks / imperative handlers
    const focusedPaneRef = useRef<PaneId>("left");
    const dragCleanupRef = useRef<(() => void) | null>(null);
    const leftPaneRef = useRef(leftPane);
    const rightPaneRef = useRef<PaneState | null>(null);
    const editorMapRef = useRef<Map<string, BlockNoteEditor<any, any, any>>>(new Map());
    const saveHandlerMapRef = useRef<Map<string, () => void>>(new Map());
    const scrollPositionMapRef = useRef<Map<string, number>>(new Map());
    const containerRef = useRef<HTMLDivElement>(null);
    const dragTrackRef = useRef<DragTrack | null>(null);

    // Split resize refs
    const isSplitResizingRef = useRef(false);
    const splitResizeStartRef = useRef({ x: 0, ratio: 50 });

    useEffect(() => { focusedPaneRef.current = focusedPane; }, [focusedPane]);
    useEffect(() => { leftPaneRef.current = leftPane; }, [leftPane]);
    useEffect(() => { rightPaneRef.current = rightPane; }, [rightPane]);
    // Remove any pending drag listeners if the component unmounts mid-drag
    useEffect(() => () => { dragCleanupRef.current?.(); }, []);

    // ── Derive active file & editor ─────────────────────────────────────────

    useEffect(() => {
      const pane = focusedPane === "left" ? leftPane : (rightPane ?? leftPane);
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
      const file = tab?.file ?? null;
      onActiveFileChange(file, file?.kind === "document" ? file.name : null);
      const editor = tab ? (editorMapRef.current.get(tab.id) ?? null) : null;
      onActiveEditorChange(editor);
    }, [focusedPane, leftPane.activeTabId, rightPane?.activeTabId]);

    // ── Save helpers ────────────────────────────────────────────────────────

    const saveActiveEditorNow = useCallback(() => {
      const pane = focusedPaneRef.current === "left"
        ? leftPaneRef.current
        : (rightPaneRef.current ?? leftPaneRef.current);
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
      if (!tab) return;
      const saveHandler = saveHandlerMapRef.current.get(tab.id);
      if (saveHandler) {
        saveHandler();
        return;
      }
      const editor = editorMapRef.current.get(tab.id);
      if (editor) (editor as any).__scholarpenSaveNow?.();
    }, []);

    const getOpenDocumentSnapshots = useCallback(() => {
      const snapshots = new Map<string, unknown[]>();
      const tabs = [
        ...leftPaneRef.current.tabs,
        ...(rightPaneRef.current?.tabs ?? []),
      ];
      for (const tab of tabs) {
        if (tab.file.kind !== "document") continue;
        const editor = editorMapRef.current.get(tab.id);
        if (!editor) continue;
        snapshots.set(
          tab.file.path,
          JSON.parse(JSON.stringify(acceptedDocument(editor))) as unknown[],
        );
      }
      return snapshots;
    }, []);

    const saveAllOpenDocuments = useCallback(async () => {
      const saveOperations = [...editorMapRef.current.values()].map((editor) =>
        Promise.resolve((editor as any).__scholarpenSaveNow?.())
      );
      await Promise.all(saveOperations);
    }, []);

    const navigateToDocumentMatch = useCallback((request: DocumentFindRequest) => {
      const panes = [["left", leftPaneRef.current], ["right", rightPaneRef.current]] as const;
      const existing = panes.flatMap(([paneId, pane]) =>
        (pane?.tabs ?? []).filter((tab) => tab.file.path === request.filePath)
          .map((tab) => ({ paneId, tab })))[0];
      const paneId = existing?.paneId ?? (rightPaneRef.current ? focusedPaneRef.current : "left");
      const tab = existing?.tab ?? {
        id: crypto.randomUUID(),
        file: { path: request.filePath, name: request.filename.split("/").at(-1)!,
          kind: "document" as const, isDirectory: false, lastModified: 0 },
      };
      setFindRequests((current) => ({ ...current, [tab.id]: request }));
      const activate = (pane: PaneState): PaneState => ({
        tabs: pane.tabs.some((candidate) => candidate.id === tab.id) ? pane.tabs : [...pane.tabs, tab],
        activeTabId: tab.id,
      });
      if (paneId === "left") setLeftPane(activate);
      else setRightPane((pane) => pane ? activate(pane) : pane);
      setFocusedPane(paneId);
    }, []);

    // ── Imperative handle ───────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      async prepareReview() {
        for (const editor of editorMapRef.current.values()) {
          if (listChangeSets(editor.prosemirrorState.doc).length) throw new Error("열린 원고의 미결정 변경 제안을 먼저 수락 또는 거절해 주세요.");
        }
        await saveAllOpenDocuments();
      },
      openFile(file: FileNode) {
        if (file.isDirectory) return;
        const paneId = focusedPaneRef.current;

        if (paneId === "left" || !rightPaneRef.current) {
          setLeftPane((prev) => {
            const existing = prev.tabs.find((t) => t.file.path === file.path);
            if (existing) {
              return {
                ...prev,
                tabs: prev.tabs.map((tab) => tab.id === existing.id ? { ...tab, file } : tab),
                activeTabId: existing.id,
              };
            }
            const tab: EditorTab = { id: crypto.randomUUID(), file };
            return { tabs: [...prev.tabs, tab], activeTabId: tab.id };
          });
          setFocusedPane("left");
        } else {
          setRightPane((prev) => {
            if (!prev) return prev;
            const existing = prev.tabs.find((t) => t.file.path === file.path);
            if (existing) {
              return {
                ...prev,
                tabs: prev.tabs.map((tab) => tab.id === existing.id ? { ...tab, file } : tab),
                activeTabId: existing.id,
              };
            }
            const tab: EditorTab = { id: crypto.randomUUID(), file };
            return { tabs: [...prev.tabs, tab], activeTabId: tab.id };
          });
          setFocusedPane("right");
        }
      },

      saveActiveEditor: saveActiveEditorNow,

      getActiveDocumentContext() {
        const pane = focusedPaneRef.current === "left"
          ? leftPaneRef.current : (rightPaneRef.current ?? leftPaneRef.current);
        const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId);
        if (!tab || tab.file.kind !== "document") return undefined;
        const editor = editorMapRef.current.get(tab.id);
        return editor ? snapshotActiveDocument(tab.file.path, acceptedDocument(editor)) : undefined;
      },

      getDocumentSnapshot(filePath: string) {
        const tabs = [
          ...leftPaneRef.current.tabs,
          ...(rightPaneRef.current?.tabs ?? []),
        ];
        const tab = tabs.find((candidate) => candidate.file.path === filePath);
        if (!tab) return null;
        const editor = editorMapRef.current.get(tab.id);
        if (!editor) return null;
        return JSON.parse(JSON.stringify(acceptedDocument(editor))) as unknown[];
      },

      openProjectFindReplace() {
        const pane = focusedPaneRef.current === "left"
          ? leftPaneRef.current
          : (rightPaneRef.current ?? leftPaneRef.current);
        const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId);
        if (!tab || tab.file.kind !== "document") return false;
        const editor = editorMapRef.current.get(tab.id);
        if (!editor) return false;
        (editor as any).__scholarpenOpenProjectFindReplace?.();
        return true;
      },

      async prepareFileDeletion(filePath: string) {
        const tabs = [...leftPaneRef.current.tabs, ...(rightPaneRef.current?.tabs ?? [])];
        const resumes = await Promise.all(tabs.filter(tab => tab.file.path === filePath).map(async tab => {
          const editor = editorMapRef.current.get(tab.id);
          return (editor as any)?.__scholarpenPrepareDelete?.() as Promise<(() => void) | undefined>;
        }));
        return () => resumes.forEach(resume => resume?.());
      },

      closeFileByPath(filePath: string) {
        const closeFrom = (pane: PaneState): PaneState => {
          const idx = pane.tabs.findIndex((t) => t.file.path === filePath);
          if (idx === -1) return pane;
          saveHandlerMapRef.current.delete(pane.tabs[idx].id);
          editorMapRef.current.delete(pane.tabs[idx].id);
          scrollPositionMapRef.current.delete(pane.tabs[idx].id);
          const newTabs = pane.tabs.filter((_, i) => i !== idx);
          const newActiveId =
            pane.activeTabId === pane.tabs[idx].id
              ? (newTabs[idx] ?? newTabs[idx - 1])?.id ?? null
              : pane.activeTabId;
          return { tabs: newTabs, activeTabId: newActiveId };
        };

        setLeftPane((p) => closeFrom(p));
        setRightPane((p) => {
          if (!p) return null;
          const updated = closeFrom(p);
          return updated.tabs.length === 0 ? null : updated;
        });
        setFocusedPane((f) => {
          if (f === "right" && (rightPaneRef.current?.tabs ?? []).filter(t => t.file.path !== filePath).length === 0) return "left";
          return f;
        });
      },
    }), [saveActiveEditorNow]);

    // ── Tab operations ──────────────────────────────────────────────────────

    const activateTab = useCallback((paneId: PaneId, tabId: string) => {
      saveActiveEditorNow();
      setFocusedPane(paneId);
      if (paneId === "left") {
        setLeftPane((p) => ({ ...p, activeTabId: tabId }));
      } else {
        setRightPane((p) => p ? { ...p, activeTabId: tabId } : p);
      }
    }, [saveActiveEditorNow]);

    const closeTab = useCallback((paneId: PaneId, tabId: string) => {
      const doClose = (pane: PaneState): PaneState => {
        const idx = pane.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return pane;
        saveHandlerMapRef.current.delete(tabId);
        editorMapRef.current.delete(tabId);
        scrollPositionMapRef.current.delete(tabId);
        const newTabs = pane.tabs.filter((t) => t.id !== tabId);
        const newActiveId =
          pane.activeTabId === tabId
            ? (newTabs[idx] ?? newTabs[idx - 1])?.id ?? null
            : pane.activeTabId;
        return { tabs: newTabs, activeTabId: newActiveId };
      };

      if (paneId === "right") {
        setRightPane((prev) => {
          if (!prev) return null;
          const updated = doClose(prev);
          return updated.tabs.length === 0 ? null : updated;
        });
        setFocusedPane((f) => {
          // If right pane had exactly 1 tab (now 0), focus left
          if (f === "right" && rightPaneRef.current?.tabs.length === 1) return "left";
          return f;
        });
        return;
      }

      // Left pane
      setLeftPane((prev) => {
        const updated = doClose(prev);
        // Left became empty while split → absorb right into left
        if (updated.tabs.length === 0 && rightPaneRef.current && rightPaneRef.current.tabs.length > 0) {
          setRightPane(null);
          setFocusedPane("left");
          return rightPaneRef.current;
        }
        return updated;
      });
    }, []);

    // ── Mouse-based drag-to-split ──────────────────────────────────────────

    const performSplit = useCallback((targetSide: "left" | "right", tabId: string, sourcePaneId: PaneId) => {
      const srcPane = sourcePaneId === "left" ? leftPaneRef.current : rightPaneRef.current;
      if (!srcPane) return;
      const tab = srcPane.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      if (!rightPaneRef.current) {
        // ── Single → split ───────────────────────────────────────────────
        const remaining = leftPaneRef.current.tabs.filter((t) => t.id !== tabId);
        const remainActiveId = remaining.find((t) => t.id === leftPaneRef.current.activeTabId)
          ? leftPaneRef.current.activeTabId
          : remaining[0]?.id ?? null;

        if (targetSide === "left") {
          setLeftPane({ tabs: [tab], activeTabId: tab.id });
          setRightPane(remaining.length > 0 ? { tabs: remaining, activeTabId: remainActiveId } : null);
          setFocusedPane("left");
        } else {
          setLeftPane({ tabs: remaining, activeTabId: remainActiveId });
          setRightPane({ tabs: [tab], activeTabId: tab.id });
          setFocusedPane("right");
        }
      } else {
        // ── Split → move between panes ───────────────────────────────────
        const targetPaneId: PaneId = targetSide;
        if (sourcePaneId === targetPaneId) return;

        if (sourcePaneId === "left") {
          setLeftPane((p) => {
            const newTabs = p.tabs.filter((t) => t.id !== tabId);
            const newActive = newTabs.find((t) => t.id === p.activeTabId)
              ? p.activeTabId : newTabs[0]?.id ?? null;
            // If left becomes empty after move, absorb right side back
            if (newTabs.length === 0) {
              setRightPane(null);
              setFocusedPane("left");
              return rightPaneRef.current ?? { tabs: [], activeTabId: null };
            }
            return { tabs: newTabs, activeTabId: newActive };
          });
          setRightPane((p) => {
            if (!p) return { tabs: [tab], activeTabId: tab.id };
            return { tabs: [...p.tabs, tab], activeTabId: tab.id };
          });
          setFocusedPane("right");
        } else {
          setRightPane((p) => {
            if (!p) return null;
            const newTabs = p.tabs.filter((t) => t.id !== tabId);
            if (newTabs.length === 0) return null;
            const newActive = newTabs.find((t) => t.id === p.activeTabId)
              ? p.activeTabId : newTabs[0]?.id ?? null;
            return { tabs: newTabs, activeTabId: newActive };
          });
          setLeftPane((p) => ({ tabs: [...p.tabs, tab], activeTabId: tab.id }));
          setFocusedPane("left");
        }
      }
    }, []);

    const handleTabMouseDown = useCallback((tabId: string, paneId: PaneId, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault(); // prevent text selection during drag

      dragTrackRef.current = {
        tabId,
        paneId,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
      };

      const handleMouseMove = (ev: MouseEvent) => {
        const track = dragTrackRef.current;
        if (!track) return;

        if (!track.active) {
          const dx = Math.abs(ev.clientX - track.startX);
          const dy = Math.abs(ev.clientY - track.startY);
          if (dx < 6 && dy < 6) return; // below threshold — not a drag yet
          track.active = true;
          setIsDragging(true);
        }

        // Highlight the side the cursor is currently over
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const relX = ev.clientX - rect.left;
          setDropSide(relX < rect.width / 2 ? "left" : "right");
        }
      };

      const handleMouseUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        dragCleanupRef.current = null;

        const track = dragTrackRef.current;
        dragTrackRef.current = null;
        setIsDragging(false);
        setDropSide(null);

        if (!track?.active) return; // was just a click, not a drag

        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const relX = ev.clientX - rect.left;
          const side = relX < rect.width / 2 ? "left" : "right";
          performSplit(side, track.tabId, track.paneId);
        }
      };

      dragCleanupRef.current = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }, [performSplit]);

    // ── Split-pane resize handle ────────────────────────────────────────────

    const handleSplitResizeMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      isSplitResizingRef.current = true;
      splitResizeStartRef.current = { x: e.clientX, ratio: splitRatio };
      const containerWidth = containerRef.current?.clientWidth ?? 0;

      const onMove = (ev: MouseEvent) => {
        if (!isSplitResizingRef.current || !containerWidth) return;
        const delta = ev.clientX - splitResizeStartRef.current.x;
        const newRatio = Math.max(
          15,
          Math.min(85, splitResizeStartRef.current.ratio + (delta / containerWidth) * 100)
        );
        setSplitRatio(newRatio);
      };
      const onUp = () => {
        isSplitResizingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }, [splitRatio]);

    // ── Render a single pane ────────────────────────────────────────────────

    const renderPane = (pane: PaneState, paneId: PaneId) => {
      const isFocused = focusedPane === paneId;
      const activeTab = pane.tabs.find(tab => tab.id === pane.activeTabId);
      const outlineIdFor = (tabId: string) => `editor-outline-${paneId}-${encodeURIComponent(tabId)}`;
      const isCurrentActiveTab = (tabId: string) => {
        const currentPane = paneId === "left" ? leftPaneRef.current : rightPaneRef.current;
        return focusedPaneRef.current === paneId && currentPane?.activeTabId === tabId;
      };

      return (
        <div
          className="flex flex-col h-full min-h-0 overflow-hidden"
          onMouseDown={() => setFocusedPane(paneId)}
        >
          <TabBar
            tabs={pane.tabs}
            activeTabId={pane.activeTabId}
            isFocused={isFocused}
            onTabClick={(tabId) => activateTab(paneId, tabId)}
            onTabClose={(tabId) => closeTab(paneId, tabId)}
            onTabMouseDown={(tabId, e) => handleTabMouseDown(tabId, paneId, e)}
            onPaneFocus={() => setFocusedPane(paneId)}
            leadingControls={(paneId === "left" || comparing) && (
              <PaneToggle side="left" open={filesOpen} label={filesOpen ? "Hide files" : "Show files"}
                controls="files-panel" onToggle={onToggleFiles} />
            )}
            trailingControls={activeTab?.file.kind === "document" && (
              <PaneToggle side="right" open={outlineVisible} label={outlineVisible ? "Hide outline" : "Show outline"}
                controls={outlineIdFor(activeTab.id)} onToggle={() => setOutlineVisible(!outlineVisible)} />
            )}
          />

          {comparing && isFocused && <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <button className="mr-auto rounded border border-border px-2 py-1 text-xs hover:bg-accent" aria-controls="files-panel" aria-expanded={filesOpen} onClick={onToggleFiles}>{filesOpen ? 'Explorer 접기' : 'Explorer 열기'}</button>
            <div role="tablist" aria-label="수정 원고와 답변서" className="flex gap-1">
              <button role="tab" aria-selected={revisionView === 'manuscript'} className={`rounded px-3 py-1 text-sm ${revisionView === 'manuscript' ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`} onClick={() => onRevisionViewChange?.('manuscript')}>수정 원고</button>
              <button role="tab" aria-selected={revisionView === 'response'} className={`rounded px-3 py-1 text-sm ${revisionView === 'response' ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`} onClick={() => onRevisionViewChange?.('response')}>답변서</button>
            </div>
          </div>}
          {comparing && isFocused && revisionView === 'response' && responsePane}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden" style={{ display: comparing && isFocused && revisionView === 'response' ? 'none' : undefined }}>
            {pane.tabs.length === 0 ? (
              <EmptyPane />
            ) : (
              pane.tabs.map((tab) => {
                const isActiveTab = pane.activeTabId === tab.id;
                const tabProject = editingProject(project, tab.file.path);
                return (
                  <div
                    key={tab.id}
                    data-revision-document={tab.file.path}
                    className="flex-1 min-h-0 flex flex-col overflow-hidden"
                    style={{ display: isActiveTab ? "flex" : "none" }}
                    aria-hidden={!isActiveTab}
                  >
                    {tabProject && project && tabProject.path !== project.path && <div className="border-b border-border bg-primary/5 px-4 py-2 text-xs text-primary break-all">수정본 · 편집 가능 · {tab.file.path.slice(project.path.length + 1)} · 이 사본에 자동 저장됩니다.</div>}
                    {tab.file.kind === "document" ? (
                      <EditorArea
                        outlineId={outlineIdFor(tab.id)}
                        project={tabProject}
                        documentFilename={tabProject ? documentRelativeFilename(tabProject.path, tab.file.path) : tab.file.name}
                        ollamaStatus={ollamaStatus}
                        initialScrollTop={scrollPositionMapRef.current.get(tab.id) ?? 0}
                        reloadTrigger={reloadTrigger}
                        bibReloadTrigger={bibReloadTrigger}
                        onEditorReady={(editor) => {
                          if (editor) {
                            editorMapRef.current.set(tab.id, editor);
                          } else {
                            editorMapRef.current.delete(tab.id);
                          }
                          if (isCurrentActiveTab(tab.id)) onActiveEditorChange(editor);
                        }}
                        onScrollPositionChange={(scrollTop) => {
                          scrollPositionMapRef.current.set(tab.id, scrollTop);
                        }}
                        onSaveStatusChange={(status) => {
                          if (isCurrentActiveTab(tab.id)) onSaveStatusChange(status);
                        }}
                        onDeepenAnalysis={onDeepenAnalysis}
                        onFindCitation={onFindCitation}
                        onCheckCitations={onCheckCitations}
                        onReviewChanges={() => {
                          if (isCurrentActiveTab(tab.id)) onReviewChanges();
                        }}
                        getOpenDocumentSnapshots={getOpenDocumentSnapshots}
                        saveAllOpenDocuments={saveAllOpenDocuments}
                        navigationRequest={findRequests[tab.id]}
                        onNavigateToDocument={navigateToDocumentMatch}
                      />
                    ) : (
                      <FileViewer
                        isActive={isActiveTab && isFocused}
                        file={tab.file}
                        projectPath={tabProject?.path ?? ""}
                        reloadTrigger={tab.file.kind === "reference" ? bibReloadTrigger : reloadTrigger}
                        onSaveReady={(saveNow) => {
                          if (saveNow) {
                            saveHandlerMapRef.current.set(tab.id, saveNow);
                          } else {
                            saveHandlerMapRef.current.delete(tab.id);
                          }
                        }}
                        onBibtexSaved={onBibtexSaved}
                        onBeforeBibliographyMaintenance={saveAllOpenDocuments}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      );
    };

    // ── Layout ──────────────────────────────────────────────────────────────

    return (
      <div ref={containerRef} className="relative flex-1 flex overflow-hidden">

        {/* Drag-to-split overlay — rendered when a tab is being dragged */}
        {isDragging && (
          <div className="absolute inset-0 z-50 flex" style={{ pointerEvents: "none" }}>
            {/* Left half */}
            <div
              className={`
                flex-1 flex items-center justify-center transition-colors duration-75
                border-2 border-dashed
                ${dropSide === "left"
                  ? "bg-primary/20 border-primary"
                  : "bg-primary/[0.08] border-primary/40"
                }
              `}
            >
              <span
                className={`
                  px-3 py-1.5 text-xs font-medium rounded-md border shadow-sm select-none
                  transition-colors duration-75
                  ${dropSide === "left"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-popover/90 text-primary border-border"
                  }
                `}
              >
                Split Left
              </span>
            </div>
            {/* Right half */}
            <div
              className={`
                flex-1 flex items-center justify-center transition-colors duration-75
                border-2 border-dashed
                ${dropSide === "right"
                  ? "bg-primary/20 border-primary"
                  : "bg-primary/[0.08] border-primary/40"
                }
              `}
            >
              <span
                className={`
                  px-3 py-1.5 text-xs font-medium rounded-md border shadow-sm select-none
                  transition-colors duration-75
                  ${dropSide === "right"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-popover/90 text-primary border-border"
                  }
                `}
              >
                Split Right
              </span>
            </div>
          </div>
        )}

        {originalPane && <div className="h-full w-1/2 min-w-0 shrink-0 border-r border-border">{originalPane}</div>}
        <div className="flex min-w-0 flex-1 overflow-hidden">
        {/* Single pane */}
        {!rightPane ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {renderPane(leftPane, "left")}
          </div>
        ) : (
          /* Split panes */
          <>
            <div
              hidden={Boolean(originalPane && focusedPane !== "left")}
              style={{ display: originalPane && focusedPane !== "left" ? "none" : undefined, width: originalPane ? "100%" : `${splitRatio}%` }}
              className="min-h-0 flex flex-col overflow-hidden border-r border-border"
            >
              {renderPane(leftPane, "left")}
            </div>

            {/* Resize handle */}
            <div
              className="w-1 flex-shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60 active:bg-primary/80"
              hidden={Boolean(originalPane)}
              onMouseDown={handleSplitResizeMouseDown}
            />

            <div
              hidden={Boolean(originalPane && focusedPane !== "right")}
              style={{ display: originalPane && focusedPane !== "right" ? "none" : undefined, width: originalPane ? "100%" : `calc(${100 - splitRatio}% - 4px)` }}
              className="min-h-0 flex flex-col overflow-hidden"
            >
              {renderPane(rightPane, "right")}
            </div>
          </>
        )}
        </div>
      </div>
    );
  }
);

// ── Empty pane placeholder ─────────────────────────────────────────────────

function EmptyPane() {
  return (
    <div className="h-full flex items-center justify-center bg-background">
      <div className="text-center text-muted-foreground/40 select-none">
        <p className="text-sm">No file open</p>
        <p className="text-xs mt-1">Open a file from the sidebar</p>
      </div>
    </div>
  );
}
