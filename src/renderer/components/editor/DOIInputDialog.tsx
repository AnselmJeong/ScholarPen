import React, { useState, useRef, useEffect } from "react";

interface DOIInputDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (doi: string) => void;
}

export function DOIInputDialog({
  isOpen,
  isLoading,
  error,
  onClose,
  onSubmit,
}: DOIInputDialogProps) {
  const [doi, setDoi] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input whenever the dialog opens; clear state on close.
  useEffect(() => {
    if (isOpen) {
      setDoi("");
      // Defer so the element is visible before focus
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = doi.trim();
    if (trimmed) onSubmit(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative bg-popover text-popover-foreground rounded-lg shadow-xl w-[440px] p-6 space-y-4 border border-border">
        <h2 className="text-sm font-semibold">Insert Citation via DOI</h2>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              DOI
            </label>
            <input
              ref={inputRef}
              type="text"
              value={doi}
              onChange={(e) => setDoi(e.target.value)}
              placeholder="10.1038/s41586-021-03819-2"
              disabled={isLoading}
              className="w-full px-3 py-2 text-sm font-mono border border-input bg-background text-foreground rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50"
            />
          </div>

          {error && (
            <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-md hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !doi.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {isLoading ? (
                <>
                  <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Resolving…
                </>
              ) : (
                "Add & Insert"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
