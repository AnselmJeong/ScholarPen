import React, { useEffect, useRef, useState } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import katex from "katex";

// ── Inline Math ─────────────────────────────────────────────────────────────
// Renders an inline LaTeX equation using KaTeX (displayMode: false).
// When formula is empty (just inserted), shows an edit input.
// Click rendered output to re-enter edit mode. Enter/Esc to commit.

function InlineMathRenderer({ formula, onEdit }: { formula: string; onEdit: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(formula || "\\square", ref.current, {
        displayMode: false,
        throwOnError: false,
        errorColor: "#cc0000",
      });
    } catch {
      if (ref.current) ref.current.textContent = formula;
    }
  }, [formula]);

  return (
    <span
      ref={ref}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(); }}
      className="cursor-pointer rounded px-0.5 text-foreground transition-colors hover:bg-accent/60"
      title="Click to edit"
    />
  );
}

function InlineMathEditor({
  formula,
  onCommit,
}: {
  formula: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(formula);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-primary/30 bg-primary/10 px-1 text-foreground">
      <span className="select-none text-xs text-primary">$</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            onCommit(value);
          }
        }}
        onBlur={() => onCommit(value)}
        placeholder="E=mc^2"
        className="min-w-[3rem] w-24 border-none bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span className="select-none text-xs text-primary">$</span>
    </span>
  );
}

export const inlineMath = createReactInlineContentSpec(
  {
    type: "inlineMath" as const,
    propSchema: {
      formula: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent, editor }) => {
      const [editing, setEditing] = useState(!inlineContent.props.formula);
      const containerRef = useRef<HTMLSpanElement>(null);

      const handleCommit = (value: string) => {
        const view = (editor as any).prosemirrorView;
        if (!view || !containerRef.current) { setEditing(false); return; }

        try {
          // Map DOM element → ProseMirror position, then update node attrs
          const pos = view.posAtDOM(containerRef.current, 0);
          const node = view.state.doc.nodeAt(pos);
          if (node && node.type.name === "inlineMath") {
            const tr = view.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              formula: value,
            });
            view.dispatch(tr);
          }
        } catch {
          // posAtDOM can throw if DOM is out of sync with ProseMirror state
          console.warn("[InlineMath] Could not locate ProseMirror position for update");
        }
        setEditing(false);
      };

      return (
        <span ref={containerRef} data-inline-math>
          {editing ? (
            <InlineMathEditor formula={inlineContent.props.formula} onCommit={handleCommit} />
          ) : (
            <InlineMathRenderer
              formula={inlineContent.props.formula}
              onEdit={() => setEditing(true)}
            />
          )}
        </span>
      );
    },
  }
);
