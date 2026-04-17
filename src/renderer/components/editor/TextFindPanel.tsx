import React, { useEffect, useRef } from "react";
import { X, ChevronUp, ChevronDown, Search } from "lucide-react";

interface TextFindPanelProps {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  currentIdx: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export function TextFindPanel({
  query,
  onQueryChange,
  matchCount,
  currentIdx,
  onNext,
  onPrev,
  onClose,
}: TextFindPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const noMatch = query.trim().length > 0 && matchCount === 0;

  return (
    <div
      className="absolute top-2 right-2 z-50 flex items-center gap-1 px-2 py-1.5 rounded-lg shadow-lg border border-border bg-background/95 backdrop-blur-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
        if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
      }}
    >
      <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />

      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Find…"
        className={[
          "w-40 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground/60",
          noMatch ? "text-red-400" : "",
        ].join(" ")}
      />

      {query.trim().length > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums min-w-[3rem] text-center select-none">
          {matchCount === 0 ? "no match" : `${currentIdx + 1}/${matchCount}`}
        </span>
      )}

      <button
        onClick={onPrev}
        disabled={matchCount === 0}
        title="Previous (⇧↵)"
        className="p-0.5 rounded hover:bg-accent disabled:opacity-30 transition-colors"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onNext}
        disabled={matchCount === 0}
        title="Next (↵)"
        className="p-0.5 rounded hover:bg-accent disabled:opacity-30 transition-colors"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      <button
        onClick={onClose}
        title="Close (Esc)"
        className="p-0.5 rounded hover:bg-accent transition-colors ml-0.5"
      >
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}
