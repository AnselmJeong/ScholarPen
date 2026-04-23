import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { EditorArea } from "./EditorArea";
import { FileViewer } from "./FileViewer";
import { TabBar } from "./TabBar";
import type { FileNode, ProjectInfo, OllamaStatus } from "@shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";

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
  closeFileByPath: (filePath: string) => void;
}

interface EditorPaneGroupProps {
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus;
  ollamaBaseUrl: string;
  reloadTrigger: number;
  bibReloadTrigger: number;
  onActiveFileChange: (file: FileNode | null, docFilename: string | null) => void;
  onActiveEditorChange: (editor: BlockNoteEditor<any, any, any> | null) => void;
  onWordCountChange: (count: number) => void;
  onSaveStatusChange: (status: SaveStatus) => void;
  onBibtexSaved: () => void;
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
      project,
      ollamaStatus,
      ollamaBaseUrl,
      reloadTrigger,
      bibReloadTrigger,
      onActiveFileChange,
      onActiveEditorChange,
      onWordCountChange,
      onSaveStatusChange,
      onBibtexSaved,
    },
    ref
  ) {
    const [leftPane, setLeftPane] = useState<PaneState>({ tabs: [], activeTabId: null });
    const [rightPane, setRightPane] = useState<PaneState | null>(null);
    const [focusedPane, setFocusedPane] = useState<PaneId>("left");
    const [splitRatio, setSplitRatio] = useState(50);

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

    // ── Imperative handle ───────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      openFile(file: FileNode) {
        if (file.isDirectory) return;
        const paneId = focusedPaneRef.current;

        if (paneId === "left" || !rightPaneRef.current) {
          setLeftPane((prev) => {
            const existing = prev.tabs.find((t) => t.file.path === file.path);
            if (existing) return { ...prev, activeTabId: existing.id };
            const tab: EditorTab = { id: crypto.randomUUID(), file };
            return { tabs: [...prev.tabs, tab], activeTabId: tab.id };
          });
          setFocusedPane("left");
        } else {
          setRightPane((prev) => {
            if (!prev) return prev;
            const existing = prev.tabs.find((t) => t.file.path === file.path);
            if (existing) return { ...prev, activeTabId: existing.id };
            const tab: EditorTab = { id: crypto.randomUUID(), file };
            return { tabs: [...prev.tabs, tab], activeTabId: tab.id };
          });
          setFocusedPane("right");
        }
      },

      saveActiveEditor: saveActiveEditorNow,

      closeFileByPath(filePath: string) {
        const closeFrom = (pane: PaneState): PaneState => {
          const idx = pane.tabs.findIndex((t) => t.file.path === filePath);
          if (idx === -1) return pane;
          saveHandlerMapRef.current.delete(pane.tabs[idx].id);
          editorMapRef.current.delete(pane.tabs[idx].id);
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
      const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;

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
          />

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {!activeTab ? (
              <EmptyPane />
            ) : activeTab.file.kind === "document" ? (
              <EditorArea
                key={activeTab.id}
                project={project}
                documentFilename={activeTab.file.name}
                ollamaStatus={ollamaStatus}
                ollamaBaseUrl={ollamaBaseUrl}
                reloadTrigger={reloadTrigger}
                bibReloadTrigger={bibReloadTrigger}
                onWordCountChange={(count) => {
                  if (focusedPaneRef.current === paneId) onWordCountChange(count);
                }}
                onEditorReady={(editor) => {
                  if (editor) {
                    editorMapRef.current.set(activeTab.id, editor);
                  } else {
                    editorMapRef.current.delete(activeTab.id);
                  }
                  if (focusedPaneRef.current === paneId) onActiveEditorChange(editor);
                }}
                onSaveStatusChange={(status) => {
                  if (focusedPaneRef.current === paneId) onSaveStatusChange(status);
                }}
              />
            ) : (
              <FileViewer
                key={activeTab.id}
                file={activeTab.file}
                reloadTrigger={activeTab.file.kind === "reference" ? bibReloadTrigger : reloadTrigger}
                onSaveReady={(saveNow) => {
                  if (saveNow) {
                    saveHandlerMapRef.current.set(activeTab.id, saveNow);
                  } else {
                    saveHandlerMapRef.current.delete(activeTab.id);
                  }
                }}
                onBibtexSaved={onBibtexSaved}
              />
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
                  ? "bg-blue-500/20 border-blue-500"
                  : "bg-blue-500/8 border-blue-300/50"
                }
              `}
            >
              <span
                className={`
                  px-3 py-1.5 text-xs font-medium rounded-md border shadow-sm select-none
                  transition-colors duration-75
                  ${dropSide === "left"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white/90 text-blue-600 border-blue-200"
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
                  ? "bg-blue-500/20 border-blue-500"
                  : "bg-blue-500/8 border-blue-300/50"
                }
              `}
            >
              <span
                className={`
                  px-3 py-1.5 text-xs font-medium rounded-md border shadow-sm select-none
                  transition-colors duration-75
                  ${dropSide === "right"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white/90 text-blue-600 border-blue-200"
                  }
                `}
              >
                Split Right
              </span>
            </div>
          </div>
        )}

        {/* Single pane */}
        {!rightPane ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {renderPane(leftPane, "left")}
          </div>
        ) : (
          /* Split panes */
          <>
            <div
              style={{ width: `${splitRatio}%` }}
              className="min-h-0 flex flex-col overflow-hidden border-r border-border"
            >
              {renderPane(leftPane, "left")}
            </div>

            {/* Resize handle */}
            <div
              className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-blue-400/60 active:bg-blue-500/80 transition-colors"
              onMouseDown={handleSplitResizeMouseDown}
            />

            <div
              style={{ width: `calc(${100 - splitRatio}% - 4px)` }}
              className="min-h-0 flex flex-col overflow-hidden"
            >
              {renderPane(rightPane, "right")}
            </div>
          </>
        )}
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
