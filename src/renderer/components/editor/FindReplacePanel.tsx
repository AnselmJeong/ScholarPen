import React, { useState, useRef, useEffect } from "react";
import { TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { BlockNoteEditor } from "@blocknote/core";
import { X, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────────

interface Match {
  from: number;
  to: number;
}

interface FindReplacePanelProps {
  editor: BlockNoteEditor<any, any, any>;
  isOpen: boolean;
  onClose: () => void;
  /** When true, the Replace row is visible on open */
  showReplaceInitially?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Component ────────────────────────────────────────────────────────────────

export function FindReplacePanel({
  editor,
  isOpen,
  onClose,
  showReplaceInitially = false,
}: FindReplacePanelProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [replaceTerm, setReplaceTerm] = useState("");
  const [showReplace, setShowReplace] = useState(showReplaceInitially);
  const [matches, setMatches] = useState<Match[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search input and reset state when panel opens/closes
  useEffect(() => {
    if (isOpen) {
      setShowReplace(showReplaceInitially);
      const t = setTimeout(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      }, 30);
      return () => clearTimeout(t);
    } else {
      // Clear on close so next open starts fresh
      setSearchTerm("");
      setReplaceTerm("");
      setMatches([]);
      setCurrentIdx(0);
    }
  }, [isOpen]);

  const getView = () => (editor as any).prosemirrorView as any;

  // ── Highlight a specific match by selecting it in ProseMirror ──────────────

  const highlightMatch = (idx: number, list: Match[]) => {
    if (list.length === 0) return;
    const view = getView();
    if (!view) return;
    const { from, to } = list[idx];
    const tr = view.state.tr
      .setSelection(TextSelection.create(view.state.doc, from, to))
      .scrollIntoView();
    view.dispatch(tr);
    // Don't call view.focus() here — it would steal focus from the panel's inputs
  };

  // ── Recalculate matches whenever searchTerm changes ──────────────────────

  useEffect(() => {
    if (!isOpen) return;
    const view = getView();
    if (!view) return;
    const found = findAllMatches(view.state.doc, searchTerm);
    setMatches(found);
    setCurrentIdx(0);
    if (found.length > 0) highlightMatch(0, found);
  }, [searchTerm, isOpen]);

  // ── Navigation ────────────────────────────────────────────────────────────

  const goNext = () => {
    if (matches.length === 0) return;
    const next = (currentIdx + 1) % matches.length;
    setCurrentIdx(next);
    highlightMatch(next, matches);
  };

  const goPrev = () => {
    if (matches.length === 0) return;
    const prev = (currentIdx - 1 + matches.length) % matches.length;
    setCurrentIdx(prev);
    highlightMatch(prev, matches);
  };

  // ── Replace ───────────────────────────────────────────────────────────────

  const replaceCurrent = () => {
    if (matches.length === 0) return;
    const view = getView();
    if (!view) return;
    const { from, to } = matches[currentIdx];
    const { state } = view;
    const tr = replaceTerm
      ? state.tr.replaceWith(from, to, state.schema.text(replaceTerm))
      : state.tr.delete(from, to);
    view.dispatch(tr);
    // Recalculate after mutation
    const found = findAllMatches(view.state.doc, searchTerm);
    setMatches(found);
    const next = Math.min(currentIdx, found.length - 1);
    setCurrentIdx(next < 0 ? 0 : next);
    if (found.length > 0) highlightMatch(next < 0 ? 0 : next, found);
  };

  const replaceAll = () => {
    if (matches.length === 0) return;
    const view = getView();
    if (!view) return;
    const { state } = view;
    // Apply from last → first to avoid position shifts invalidating earlier positions
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
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────

  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    // Block ALL key events from reaching BlockNote below
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      getView()?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? goPrev() : goNext();
    }
  };

  if (!isOpen) return null;

  const hasNoMatches = searchTerm.length > 0 && matches.length === 0;

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        zIndex: 50,
        width: 300,
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
      {/* ── Header ──────────────────────────────────────────────────── */}
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
            onMouseDown={(e) => { e.preventDefault(); onClose(); getView()?.focus(); }}
            title="Close (Esc)"
            style={iconBtnStyle}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* ── Search row ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          ref={searchRef}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Find…"
          style={{
            ...inputStyle,
            borderColor: hasNoMatches ? "hsl(var(--destructive))" : "hsl(var(--border))",
          }}
          spellCheck={false}
        />
        <span style={counterStyle}>
          {searchTerm
            ? matches.length === 0
              ? "0 / 0"
              : `${currentIdx + 1} / ${matches.length}`
            : ""}
        </span>
        <button
          onMouseDown={(e) => { e.preventDefault(); goPrev(); }}
          disabled={matches.length === 0}
          title="Previous (Shift+Enter)"
          style={iconBtnStyle}
        >
          <ChevronUp size={13} />
        </button>
        <button
          onMouseDown={(e) => { e.preventDefault(); goNext(); }}
          disabled={matches.length === 0}
          title="Next (Enter)"
          style={iconBtnStyle}
        >
          <ChevronDown size={13} />
        </button>
      </div>

      {/* ── Replace row ─────────────────────────────────────────────── */}
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
            onMouseDown={(e) => { e.preventDefault(); replaceCurrent(); }}
            disabled={matches.length === 0}
            title="Replace this"
            style={actionBtnStyle}
          >
            1
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); replaceAll(); }}
            disabled={matches.length === 0}
            title="Replace all"
            style={actionBtnStyle}
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

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
