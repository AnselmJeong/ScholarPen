import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  X,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Files,
  FileText,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { rpc } from "../../rpc";
import { collectDocumentNodes } from "../../utils/document-tree";
import {
  findDocumentTextMatches,
  replaceDocumentText,
  type DocumentTextMatch,
} from "../../utils/document-text-replace";

// ── Types ────────────────────────────────────────────────────────────────────

interface Match {
  from: number;
  to: number;
}

type FindScope = "document" | "project";

interface ProjectMatch extends DocumentTextMatch {
  filePath: string;
  filename: string;
  documentMatchIndex: number;
}

interface ProjectDocument {
  filePath: string;
  filename: string;
  content: unknown;
}

interface FindReplacePanelProps {
  editor: BlockNoteEditor<any, any, any>;
  isOpen: boolean;
  onClose: () => void;
  showReplaceInitially?: boolean;
  initialScope?: FindScope;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  projectPath: string;
  documentFilename: string;
  getOpenDocumentSnapshots?: () => Map<string, unknown[]>;
  saveAllOpenDocuments?: () => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findAllMatches(doc: PMNode, term: string): Match[] {
  if (!term) return [];
  const results: Match[] = [];
  const lower = term.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let i = 0;
    while ((i = text.indexOf(lower, i)) !== -1) {
      results.push({ from: pos + i, to: pos + i + term.length });
      i += term.length;
    }
  });
  return results;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FindReplacePanel({
  editor,
  isOpen,
  onClose,
  showReplaceInitially = false,
  initialScope = "document",
  scrollContainerRef,
  projectPath,
  documentFilename,
  getOpenDocumentSnapshots,
  saveAllOpenDocuments,
}: FindReplacePanelProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [replaceTerm, setReplaceTerm] = useState("");
  const [showReplace, setShowReplace] = useState(showReplaceInitially);
  const [scope, setScope] = useState<FindScope>("document");
  const [matches, setMatches] = useState<Match[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [projectMatches, setProjectMatches] = useState<ProjectMatch[]>([]);
  const [projectIdx, setProjectIdx] = useState(0);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectMutating, setProjectMutating] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectStatus, setProjectStatus] = useState<string | null>(null);
  const [confirmReplaceAll, setConfirmReplaceAll] = useState(false);

  // Refs so the decorations closure always has fresh values
  const matchesRef = useRef<Match[]>([]);
  const currentIdxRef = useRef(0);
  matchesRef.current = matches;
  currentIdxRef.current = currentIdx;

  const searchRef = useRef<HTMLInputElement>(null);
  const projectSearchSeqRef = useRef(0);
  const selectedProjectMatchRef = useRef<HTMLButtonElement>(null);

  // Safe view accessor — returns null if editor/view is not yet mounted or already destroyed
  const getView = useCallback(() => {
    try {
      const view = (editor as any).prosemirrorView;
      if (!view || typeof view.setProps !== "function" || !view.docView) return null;
      return view;
    } catch {
      return null;
    }
  }, [editor]);

  // ── Decorations ────────────────────────────────────────────────────────────
  // Apply yellow highlight for all matches + orange for the current one.
  // Uses view.setProps({ decorations }) so we never call replaceBlocks
  // and never cause a cursor jump.

  const applyDecorations = useCallback((list: Match[], idx: number) => {
    const view = getView();
    if (!view) return;
    try {
      view.setProps({
        decorations: (state: any) => {
          const decos = list.flatMap((m, i) => {
            if (m.from < 0 || m.to > state.doc.content.size) return [];
            const isCurrent = i === idx;
            return [
              Decoration.inline(m.from, m.to, {
                style: isCurrent
                  ? "background:rgba(251,146,60,0.55);border-radius:2px;outline:1.5px solid rgba(251,146,60,0.8);"
                  : "background:rgba(253,224,71,0.45);border-radius:2px;",
              }),
            ];
          });
          return DecorationSet.create(state.doc, decos);
        },
      });
    } catch { /* view may have unmounted between check and call */ }
  }, [getView]);

  const clearDecorations = useCallback(() => {
    const view = getView();
    if (!view) return;
    try {
      view.setProps({ decorations: undefined });
    } catch { /* view may have unmounted */ }
  }, [getView]);

  const loadProjectDocuments = useCallback(async (
    preferOpenSnapshots: boolean,
  ): Promise<ProjectDocument[]> => {
    const tree = await rpc.listProjectFiles(projectPath);
    const documentsFolder = tree.find(
      (node) => node.isDirectory && node.name === "documents",
    );
    const documentNodes = documentsFolder
      ? collectDocumentNodes([documentsFolder])
      : [];
    const openSnapshots = preferOpenSnapshots
      ? getOpenDocumentSnapshots?.() ?? new Map<string, unknown[]>()
      : new Map<string, unknown[]>();

    return Promise.all(documentNodes.map(async (node) => ({
      filePath: node.path,
      filename: node.name,
      content: openSnapshots.get(node.path)
        ?? await rpc.loadDocument(projectPath, node.name),
    })));
  }, [getOpenDocumentSnapshots, projectPath]);

  const scanProject = useCallback(async (
    preferOpenSnapshots = true,
    preserveStatus = false,
  ) => {
    const requestSeq = ++projectSearchSeqRef.current;
    if (!searchTerm) {
      setProjectMatches([]);
      setProjectIdx(0);
      setProjectLoading(false);
      return;
    }

    setProjectLoading(true);
    setProjectError(null);
    if (!preserveStatus) setProjectStatus(null);
    try {
      const documents = await loadProjectDocuments(preferOpenSnapshots);
      const found = documents.flatMap((document) =>
        findDocumentTextMatches(document.content, searchTerm).map((match, index) => ({
          ...match,
          filePath: document.filePath,
          filename: document.filename,
          documentMatchIndex: index,
        })),
      );
      if (requestSeq !== projectSearchSeqRef.current) return;
      setProjectMatches(found);
      setProjectIdx((current) => Math.max(0, Math.min(current, found.length - 1)));
    } catch (error) {
      if (requestSeq !== projectSearchSeqRef.current) return;
      setProjectMatches([]);
      setProjectIdx(0);
      setProjectError(
        error instanceof Error ? error.message : "Could not search project documents.",
      );
    } finally {
      if (requestSeq === projectSearchSeqRef.current) setProjectLoading(false);
    }
  }, [loadProjectDocuments, searchTerm]);

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // Focus input when panel opens; reset everything on close.
  useEffect(() => {
    if (isOpen) {
      setShowReplace(showReplaceInitially);
      setScope(initialScope);
      const t = setTimeout(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      }, 30);
      return () => clearTimeout(t);
    } else {
      projectSearchSeqRef.current += 1;
      clearDecorations();
      setSearchTerm("");
      setReplaceTerm("");
      setScope(initialScope);
      setMatches([]);
      setCurrentIdx(0);
      setProjectMatches([]);
      setProjectIdx(0);
      setProjectLoading(false);
      setProjectMutating(false);
      setProjectError(null);
      setProjectStatus(null);
      setConfirmReplaceAll(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setScope(initialScope);
    setShowReplace(showReplaceInitially);
  }, [initialScope, isOpen, showReplaceInitially]);

  // Cleanup decorations if the component ever unmounts
  useEffect(() => () => clearDecorations(), []);

  // ── Navigate to a match ────────────────────────────────────────────────────
  // Move the cursor (NOT a text selection) to the match start and scroll to it.
  // Collapsed cursor means BlockNote's FormattingToolbar will NOT appear.

  const goToMatch = useCallback((idx: number, list: Match[]) => {
    if (list.length === 0) return;
    const view = getView();
    if (!view) return;
    try {
      const { from } = list[idx];
      const tr = view.state.tr
        .setSelection(TextSelection.create(view.state.doc, from))
        .scrollIntoView();
      view.dispatch(tr);
      requestAnimationFrame(() => {
        const container = scrollContainerRef?.current;
        if (!container) return;
        try {
          const coords = view.coordsAtPos(from);
          const containerRect = container.getBoundingClientRect();
          const targetTop = container.scrollTop + coords.top - containerRect.top;
          container.scrollTo({
            top: Math.max(0, targetTop - container.clientHeight * 0.35),
            behavior: "smooth",
          });
        } catch { /* position may no longer be visible after document changes */ }
      });
      applyDecorations(list, idx);
    } catch { /* editor may have unmounted during navigation */ }
  }, [getView, applyDecorations, scrollContainerRef]);

  // ── Recalculate matches on searchTerm change ───────────────────────────────

  useEffect(() => {
    if (!isOpen || scope !== "document") {
      clearDecorations();
      return;
    }
    const view = getView();
    if (!view) return;
    const found = findAllMatches(view.state.doc, searchTerm);
    setMatches(found);
    setCurrentIdx(0);
    if (found.length > 0) {
      goToMatch(0, found);
    } else {
      clearDecorations();
    }
  }, [searchTerm, isOpen, scope]);

  useEffect(() => {
    if (!isOpen || scope !== "project") return;
    clearDecorations();
    setConfirmReplaceAll(false);
    const timer = setTimeout(() => {
      void scanProject(true);
    }, 220);
    return () => clearTimeout(timer);
  }, [isOpen, scope, searchTerm, scanProject, clearDecorations]);

  useEffect(() => {
    if (scope !== "project") return;
    selectedProjectMatchRef.current?.scrollIntoView({ block: "nearest" });
  }, [projectIdx, scope]);

  // ── Navigation ────────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    const next = (currentIdx + 1) % matches.length;
    setCurrentIdx(next);
    goToMatch(next, matches);
  }, [currentIdx, matches, goToMatch]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    const prev = (currentIdx - 1 + matches.length) % matches.length;
    setCurrentIdx(prev);
    goToMatch(prev, matches);
  }, [currentIdx, matches, goToMatch]);

  const goNextActive = useCallback(() => {
    if (scope === "document") {
      goNext();
      return;
    }
    if (projectMatches.length === 0) return;
    setProjectIdx((current) => (current + 1) % projectMatches.length);
  }, [goNext, projectMatches.length, scope]);

  const goPrevActive = useCallback(() => {
    if (scope === "document") {
      goPrev();
      return;
    }
    if (projectMatches.length === 0) return;
    setProjectIdx((current) => (current - 1 + projectMatches.length) % projectMatches.length);
  }, [goPrev, projectMatches.length, scope]);

  // ── Replace ───────────────────────────────────────────────────────────────

  const replaceCurrent = useCallback(() => {
    if (matches.length === 0) return;
    const view = getView();
    if (!view) return;
    try {
      const { from, to } = matches[currentIdx];
      const { state } = view;
      const tr = replaceTerm
        ? state.tr.replaceWith(from, to, state.schema.text(replaceTerm))
        : state.tr.delete(from, to);
      view.dispatch(tr);
      const found = findAllMatches(view.state.doc, searchTerm);
      const next = Math.max(0, Math.min(currentIdx, found.length - 1));
      setMatches(found);
      setCurrentIdx(next);
      if (found.length > 0) goToMatch(next, found);
      else clearDecorations();
    } catch { /* editor may have unmounted */ }
  }, [matches, currentIdx, replaceTerm, searchTerm, getView, goToMatch, clearDecorations]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0) return;
    const view = getView();
    if (!view) return;
    try {
      const { state } = view;
      let tr = state.tr;
      for (let i = matches.length - 1; i >= 0; i--) {
        const { from, to } = matches[i];
        if (replaceTerm) {
          tr = tr.replaceWith(from, to, state.schema.text(replaceTerm));
        } else {
          tr = tr.delete(from, to);
        }
      }
      view.dispatch(tr);
      setMatches([]);
      setCurrentIdx(0);
      clearDecorations();
    } catch { /* editor may have unmounted */ }
  }, [matches, replaceTerm, getView, clearDecorations]);

  const replaceProject = useCallback(async (replaceEveryMatch: boolean) => {
    if (
      projectMutating
      || projectLoading
      || projectMatches.length === 0
      || !searchTerm
    ) return;

    setProjectMutating(true);
    setProjectError(null);
    setProjectStatus(null);
    try {
      if (saveAllOpenDocuments) {
        await saveAllOpenDocuments();
      } else {
        await Promise.resolve((editor as any).__scholarpenSaveNow?.());
      }

      const documents = await loadProjectDocuments(false);
      const writes: Array<{ filename: string; content: unknown }> = [];
      let replacementCount = 0;

      if (replaceEveryMatch) {
        for (const document of documents) {
          const result = replaceDocumentText(
            document.content,
            searchTerm,
            replaceTerm,
          );
          if (result.replacementCount === 0) continue;
          replacementCount += result.replacementCount;
          writes.push({ filename: document.filename, content: result.content });
        }
      } else {
        const selected = projectMatches[projectIdx];
        const document = documents.find((candidate) => candidate.filePath === selected?.filePath);
        if (!selected || !document) {
          throw new Error("The selected occurrence is no longer available. Review the results and try again.");
        }
        const result = replaceDocumentText(
          document.content,
          searchTerm,
          replaceTerm,
          selected.documentMatchIndex,
        );
        if (result.replacementCount === 0) {
          throw new Error("The selected occurrence changed. Review the results and try again.");
        }
        replacementCount = result.replacementCount;
        writes.push({ filename: document.filename, content: result.content });
      }

      if (writes.length === 0) {
        setProjectStatus("No replacements were needed.");
        await scanProject(false, true);
        return;
      }

      await rpc.saveDocuments(projectPath, writes);
      setProjectStatus(
        `${replacementCount} ${replacementCount === 1 ? "replacement" : "replacements"} in `
        + `${writes.length} ${writes.length === 1 ? "document" : "documents"}.`,
      );
      setConfirmReplaceAll(false);
      await scanProject(false, true);
    } catch (error) {
      setProjectError(
        error instanceof Error ? error.message : "Could not replace project text.",
      );
    } finally {
      setProjectMutating(false);
    }
  }, [
    editor,
    loadProjectDocuments,
    projectIdx,
    projectLoading,
    projectMatches,
    projectMutating,
    projectPath,
    replaceTerm,
    saveAllOpenDocuments,
    scanProject,
    searchTerm,
  ]);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  // Stop all key events so nothing leaks through to BlockNote.

  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      getView()?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? goPrevActive() : goNextActive();
    }
  }, [onClose, getView, goNextActive, goPrevActive]);

  useEffect(() => {
    setConfirmReplaceAll(false);
  }, [searchTerm, replaceTerm, scope]);

  const projectGroups = useMemo(() => {
    const groups = new Map<string, {
      filename: string;
      filePath: string;
      matches: Array<ProjectMatch & { globalIndex: number }>;
    }>();
    projectMatches.forEach((match, globalIndex) => {
      const group = groups.get(match.filePath) ?? {
        filename: match.filename,
        filePath: match.filePath,
        matches: [],
      };
      group.matches.push({ ...match, globalIndex });
      groups.set(match.filePath, group);
    });
    return [...groups.values()];
  }, [projectMatches]);

  if (!isOpen) return null;

  const activeMatchCount = scope === "document" ? matches.length : projectMatches.length;
  const activeMatchIndex = scope === "document" ? currentIdx : projectIdx;
  const noMatches = searchTerm.length > 0
    && !projectLoading
    && activeMatchCount === 0;

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        zIndex: 50,
        width: scope === "project" ? 430 : 300,
        background: "hsl(var(--background))",
        border: "1px solid hsl(var(--border))",
        borderRadius: 8,
        boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
        padding: "10px 10px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      onKeyDown={handlePanelKeyDown}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={headerLabelStyle}>
          {showReplace ? "Find & Replace" : "Find"}
        </span>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            onMouseDown={(e) => { e.preventDefault(); setShowReplace((v) => !v); }}
            title={showReplace ? "Hide replace" : "Show replace"}
            style={iconBtnStyle}
          >
            <ChevronsUpDown size={12} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              onClose();
              getView()?.focus();
            }}
            title="Close (Esc)"
            style={iconBtnStyle}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* ── Scope ───────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 2,
          padding: 2,
          borderRadius: 6,
          background: "hsl(var(--muted))",
        }}
      >
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            setScope("document");
            setProjectError(null);
          }}
          style={scopeButtonStyle(scope === "document")}
        >
          <FileText size={11} />
          This document
        </button>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            setScope("project");
            setProjectError(null);
          }}
          style={scopeButtonStyle(scope === "project")}
        >
          <Files size={11} />
          All documents
        </button>
      </div>

      {/* ── Search row ──────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          ref={searchRef}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Find…"
          style={{
            ...inputStyle,
            borderColor: noMatches
              ? "hsl(var(--destructive))"
              : "hsl(var(--border))",
          }}
          spellCheck={false}
        />
        <span style={counterStyle}>
          {searchTerm
            ? activeMatchCount === 0
              ? "0 / 0"
              : `${activeMatchIndex + 1} / ${activeMatchCount}`
            : ""}
        </span>
        <button
          onMouseDown={(e) => { e.preventDefault(); goPrevActive(); }}
          disabled={activeMatchCount === 0 || projectLoading}
          title="Previous (Shift+Enter)"
          style={iconBtnStyle}
        >
          <ChevronUp size={13} />
        </button>
        <button
          onMouseDown={(e) => { e.preventDefault(); goNextActive(); }}
          disabled={activeMatchCount === 0 || projectLoading}
          title="Next (Enter)"
          style={iconBtnStyle}
        >
          <ChevronDown size={13} />
        </button>
      </div>

      {/* ── Replace row ─────────────────────────────────────────── */}
      {showReplace && (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input
            value={replaceTerm}
            onChange={(e) => setReplaceTerm(e.target.value)}
            placeholder="Replace with…"
            style={inputStyle}
            spellCheck={false}
          />
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              if (scope === "document") replaceCurrent();
              else void replaceProject(false);
            }}
            disabled={activeMatchCount === 0 || projectLoading || projectMutating}
            title={scope === "project" ? "Replace selected occurrence" : "Replace this"}
            style={actionBtnStyle}
          >
            Replace
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              if (scope === "document") replaceAll();
              else setConfirmReplaceAll(true);
            }}
            disabled={activeMatchCount === 0 || projectLoading || projectMutating}
            title={scope === "project" ? "Replace across all documents" : "Replace all"}
            style={actionBtnStyle}
          >
            All
          </button>
        </div>
      )}

      {scope === "project" && searchTerm && (
        <div
          style={{
            maxHeight: 236,
            overflowY: "auto",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            background: "hsl(var(--muted) / 0.24)",
          }}
        >
          {projectLoading ? (
            <div style={emptyStateStyle}>
              <Loader2 size={14} className="animate-spin" />
              Searching documents…
            </div>
          ) : projectGroups.length === 0 ? (
            <div style={emptyStateStyle}>No matches in the documents folder.</div>
          ) : (
            projectGroups.map((group) => (
              <div key={group.filePath}>
                <div
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 8px",
                    borderBottom: "1px solid hsl(var(--border))",
                    background: "hsl(var(--muted))",
                    color: "hsl(var(--muted-foreground))",
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                >
                  <FileText size={11} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {group.filename.replace(".scholarpen.json", "")}
                  </span>
                  {group.filename === documentFilename && (
                    <span style={{ color: "hsl(var(--primary))" }}>open</span>
                  )}
                  <span>{group.matches.length}</span>
                </div>
                {group.matches.map((match) => {
                  const selected = match.globalIndex === projectIdx;
                  return (
                    <button
                      key={`${match.filePath}:${match.documentMatchIndex}`}
                      ref={selected ? selectedProjectMatchRef : undefined}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setProjectIdx(match.globalIndex);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "6px 8px",
                        border: "none",
                        borderBottom: "1px solid hsl(var(--border) / 0.55)",
                        background: selected
                          ? "hsl(var(--primary) / 0.09)"
                          : "transparent",
                        color: "hsl(var(--foreground))",
                        textAlign: "left",
                        cursor: "pointer",
                        fontSize: 11,
                        lineHeight: 1.45,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {highlightSnippet(match.snippet, searchTerm, match.snippetOffset)}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}

      {scope === "project" && confirmReplaceAll && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "7px 8px",
            borderRadius: 6,
            border: "1px solid hsl(var(--destructive) / 0.35)",
            background: "hsl(var(--destructive) / 0.07)",
            color: "hsl(var(--foreground))",
            fontSize: 11,
          }}
        >
          <AlertTriangle size={13} style={{ color: "hsl(var(--destructive))", flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            Replace {projectMatches.length} occurrences across {projectGroups.length} documents?
            <span style={{ display: "block", marginTop: 2, color: "hsl(var(--muted-foreground))" }}>
              A recovery copy is saved automatically.
            </span>
          </span>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setConfirmReplaceAll(false); }}
            style={confirmButtonStyle(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); void replaceProject(true); }}
            style={confirmButtonStyle(true)}
          >
            Replace all
          </button>
        </div>
      )}

      {scope === "project" && (projectError || projectStatus || projectMutating) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minHeight: 20,
            color: projectError
              ? "hsl(var(--destructive))"
              : "hsl(var(--muted-foreground))",
            fontSize: 10,
          }}
        >
          {projectMutating
            ? <Loader2 size={12} className="animate-spin" />
            : projectError
              ? <AlertTriangle size={12} />
              : <CheckCircle2 size={12} style={{ color: "hsl(var(--primary))" }} />}
          <span>
            {projectMutating ? "Saving and replacing…" : projectError ?? projectStatus}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function highlightSnippet(
  snippet: string,
  searchTerm: string,
  expectedOffset: number,
): React.ReactNode {
  const index = snippet
    .slice(expectedOffset, expectedOffset + searchTerm.length)
    .toLocaleLowerCase() === searchTerm.toLocaleLowerCase()
    ? expectedOffset
    : snippet.toLocaleLowerCase().indexOf(searchTerm.toLocaleLowerCase());
  if (index === -1) return snippet;
  return (
    <>
      {snippet.slice(0, index)}
      <mark
        style={{
          padding: "0 1px",
          borderRadius: 2,
          background: "rgba(251, 191, 36, 0.35)",
          color: "inherit",
        }}
      >
        {snippet.slice(index, index + searchTerm.length)}
      </mark>
      {snippet.slice(index + searchTerm.length)}
    </>
  );
}

function scopeButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 24,
    borderRadius: 4,
    border: active ? "1px solid hsl(var(--border))" : "1px solid transparent",
    background: active ? "hsl(var(--background))" : "transparent",
    color: active ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
    boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
    fontSize: 10,
    fontWeight: active ? 600 : 500,
    cursor: "pointer",
  };
}

function confirmButtonStyle(primary: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    padding: "3px 7px",
    borderRadius: 4,
    border: primary
      ? "1px solid hsl(var(--destructive))"
      : "1px solid hsl(var(--border))",
    background: primary
      ? "hsl(var(--destructive))"
      : "hsl(var(--background))",
    color: primary
      ? "hsl(var(--destructive-foreground))"
      : "hsl(var(--foreground))",
    fontSize: 10,
    fontWeight: 600,
    cursor: "pointer",
  };
}

const headerLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "hsl(var(--muted-foreground))",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--background))",
  color: "hsl(var(--foreground))",
  outline: "none",
};

const counterStyle: React.CSSProperties = {
  fontSize: 10,
  color: "hsl(var(--muted-foreground))",
  whiteSpace: "nowrap",
  minWidth: 36,
  textAlign: "right",
  flexShrink: 0,
};

const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: "hsl(var(--foreground))",
  cursor: "pointer",
  flexShrink: 0,
  opacity: 0.7,
};

const actionBtnStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: "3px 8px",
  borderRadius: 4,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--muted))",
  color: "hsl(var(--foreground))",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const emptyStateStyle: React.CSSProperties = {
  minHeight: 68,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  padding: 12,
  color: "hsl(var(--muted-foreground))",
  fontSize: 11,
  textAlign: "center",
};
