import React, { useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import katex from "katex";
import "katex/dist/katex.min.css";

// ── Math Block ──────────────────────────────────────────────────────────────
// Renders a LaTeX equation using KaTeX.
// Click to enter edit mode; press Enter or Escape to commit.

function MathRenderer({ formula, onEdit }: { formula: string; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(formula || "\\square", ref.current, {
        displayMode: true,
        throwOnError: false,
        errorColor: "#cc0000",
      });
    } catch {
      if (ref.current) ref.current.textContent = formula;
    }
  }, [formula]);

  return (
    <div
      ref={ref}
      onClick={onEdit}
      className="cursor-pointer rounded py-2 text-center text-foreground transition-colors hover:bg-accent/60"
      title="Click to edit"
    />
  );
}

function MathEditor({
  formula,
  onCommit,
}: {
  formula: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(formula);
  const [preview, setPreview] = useState<string>("");
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!previewRef.current) return;
    try {
      katex.render(value || "\\square", previewRef.current, {
        displayMode: true,
        throwOnError: false,
        errorColor: "#cc0000",
      });
      setPreview("");
    } catch (err) {
      setPreview(String(err));
    }
  }, [value]);

  const commit = () => onCommit(value);

  return (
    <div className="flex flex-col gap-2 py-2">
      <div ref={previewRef} className="text-center" />
      {preview && (
        <p className="px-2 text-xs text-destructive">{preview}</p>
      )}
      <textarea
        autoFocus
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder="LaTeX formula, e.g. E = mc^2"
        className="w-full resize-none rounded border border-input bg-background px-2 py-1 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <p className="text-xs text-muted-foreground">Enter or Escape to confirm · Shift+Enter for new line</p>
    </div>
  );
}

export const mathBlock = createReactBlockSpec(
  {
    type: "math" as const,
    propSchema: {
      formula: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const [editing, setEditing] = useState(!block.props.formula);

      const handleCommit = (value: string) => {
        editor.updateBlock(block, { props: { formula: value } });
        setEditing(false);
      };

      return (
        <div className="my-1 w-full select-none rounded-md border border-border bg-card px-4 py-1 text-card-foreground">
          <div className="mb-1 text-xs text-muted-foreground">Math</div>
          {editing ? (
            <MathEditor formula={block.props.formula} onCommit={handleCommit} />
          ) : (
            <MathRenderer formula={block.props.formula} onEdit={() => setEditing(true)} />
          )}
        </div>
      );
    },
  }
);
