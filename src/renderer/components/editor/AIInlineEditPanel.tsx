import React, { useState, useRef, useCallback, useEffect } from "react";
import ReactDOM from "react-dom";
import { Sparkles, X, Check, RefreshCw, StopCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SelectionSnapshot {
  /** ProseMirror positions — used for the final replaceWith dispatch */
  from: number;
  to: number;
  selectedText: string;
  /** Viewport coords of the selection's bounding rect */
  top: number;
  bottom: number;
  left: number;
}

interface AIInlineEditPanelProps {
  snapshot: SelectionSnapshot;
  model: string;
  onAccept: (from: number, to: number, newText: string) => void;
  onClose: () => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

const PANEL_WIDTH = 440;
const PANEL_HEIGHT_EST = 290; // used only for flip-above logic

const QUICK_ACTIONS = [
  { label: "Improve",   prompt: "Improve the writing quality and clarity of" },
  { label: "Shorten",   prompt: "Shorten and make more concise" },
  { label: "Formalize", prompt: "Make more formal and academic" },
  { label: "Simplify",  prompt: "Simplify the language of" },
];

const TRANSLATE_LANGS = [
  { label: "Korean",   prompt: "Translate to Korean" },
  { label: "English",  prompt: "Translate to English" },
  { label: "Japanese", prompt: "Translate to Japanese" },
  { label: "Chinese",  prompt: "Translate to Chinese" },
  { label: "Spanish",  prompt: "Translate to Spanish" },
  { label: "French",   prompt: "Translate to French" },
  { label: "German",   prompt: "Translate to German" },
];

const SYSTEM_PROMPT =
  "You are an academic writing assistant. The user gives a short instruction and a text passage. " +
  "Rewrite the passage following the instruction. " +
  "Return ONLY the rewritten text — no explanation, no preamble, no surrounding quotes. " +
  "The output must be a direct drop-in replacement for the original passage.";

// ── Component ────────────────────────────────────────────────────────────────

export function AIInlineEditPanel({
  snapshot,
  model,
  onAccept,
  onClose,
}: AIInlineEditPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [translateOpen, setTranslateOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const translateRef = useRef<HTMLDivElement>(null);

  // Close translate dropdown on outside click
  useEffect(() => {
    if (!translateOpen) return;
    const handler = (e: MouseEvent) => {
      if (!translateRef.current?.contains(e.target as Node)) setTranslateOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [translateOpen]);

  // Auto-focus the input when the panel opens
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  // Close on Escape globally
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const run = useCallback(
    async (instruction: string) => {
      if (!instruction.trim()) return;
      setResult("");
      setError("");
      setLoading(true);
      abortRef.current = new AbortController();
      let accumulated = "";

      try {
        const res = await fetch("http://localhost:11434/api/chat", {
          method: "POST",
          signal: abortRef.current.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: `${instruction}:\n\n${snapshot.selectedText}`,
              },
            ],
            stream: true,
            think: false,
          }),
        });

        if (!res.ok || !res.body)
          throw new Error(`Ollama error: HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value, { stream: true }).split("\n")) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as {
                message?: { content?: string };
                done?: boolean;
              };
              if (parsed.message?.content) {
                accumulated += parsed.message.content;
                setResult(accumulated);
              }
            } catch {
              /* skip malformed lines */
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError((err as Error).message);
        }
      } finally {
        setLoading(false);
      }
    },
    [model, snapshot.selectedText]
  );

  const handleAccept = () => {
    if (result) onAccept(snapshot.from, snapshot.to, result);
  };

  const handleRetry = () => {
    setResult("");
    setError("");
    setPrompt("");
  };

  // ── Positioning ───────────────────────────────────────────────────────────
  // Place below the selection; flip above if near the bottom of the viewport.
  const wouldOverflowBottom =
    snapshot.bottom + 8 + PANEL_HEIGHT_EST > window.innerHeight;
  const top = wouldOverflowBottom
    ? Math.max(8, snapshot.top - PANEL_HEIGHT_EST - 8)
    : snapshot.bottom + 8;
  const left = Math.max(
    8,
    Math.min(snapshot.left, window.innerWidth - PANEL_WIDTH - 8)
  );

  // ── Render ────────────────────────────────────────────────────────────────
  const phase: "input" | "streaming" | "result" | "error" = error
    ? "error"
    : loading
    ? "streaming"
    : result
    ? "result"
    : "input";

  return ReactDOM.createPortal(
    <div
      style={{
        position: "fixed",
        top,
        left,
        width: PANEL_WIDTH,
        zIndex: 9999,
      }}
      className="bg-popover text-popover-foreground border border-border rounded-xl shadow-2xl p-4 flex flex-col gap-3"
      // Prevent the underlying editor from handling these mouse events
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Edit with AI
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Selected text preview */}
      <div className="text-xs text-muted-foreground bg-muted rounded-md px-2.5 py-1.5 line-clamp-2 italic border border-border leading-relaxed">
        &ldquo;{snapshot.selectedText}&rdquo;
      </div>

      {/* ── Input phase ── */}
      {phase === "input" && (
        <>
          {/* Quick-action chips */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.label}
                onClick={() => { setPrompt(a.prompt); run(a.prompt); }}
                className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium"
              >
                {a.label}
              </button>
            ))}

            {/* Translate dropdown */}
            <div ref={translateRef} className="relative">
              <button
                onClick={() => setTranslateOpen((v) => !v)}
                className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium flex items-center gap-1"
              >
                Translate
                <ChevronDown className="h-3 w-3" />
              </button>
              {translateOpen && (
                <div className="absolute left-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg overflow-hidden z-50 min-w-[120px]">
                  {TRANSLATE_LANGS.map((lang) => (
                    <button
                      key={lang.label}
                      onClick={() => {
                        setTranslateOpen(false);
                        setPrompt(lang.prompt);
                        run(lang.prompt);
                      }}
                      className="w-full text-left text-xs px-3 py-1.5 hover:bg-accent text-foreground transition-colors"
                    >
                      {lang.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Free-form input */}
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  run(prompt);
                }
              }}
              placeholder="Custom instruction, e.g. 'translate to Japanese'…"
              rows={2}
              className="flex-1 text-sm bg-background text-foreground border border-input rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
            <Button
              size="sm"
              onClick={() => run(prompt)}
              disabled={!prompt.trim()}
              className="self-end"
            >
              Go
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Enter to submit · Esc to close
          </p>
        </>
      )}

      {/* ── Streaming phase ── */}
      {phase === "streaming" && (
        <>
          <div className="text-sm text-foreground bg-accent/30 border border-border rounded-lg px-3 py-2.5 min-h-[72px] whitespace-pre-wrap leading-relaxed">
            {result}
            <span className="animate-pulse text-primary ml-0.5">▋</span>
          </div>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                abortRef.current?.abort();
                setLoading(false);
              }}
              className="text-xs text-muted-foreground gap-1"
            >
              <StopCircle className="h-3.5 w-3.5" />
              Stop
            </Button>
          </div>
        </>
      )}

      {/* ── Result phase ── */}
      {phase === "result" && (
        <>
          <div className="text-sm text-foreground bg-accent/30 border border-border rounded-lg px-3 py-2.5 min-h-[60px] whitespace-pre-wrap leading-relaxed">
            {result}
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={handleRetry}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleAccept} className="gap-1">
                <Check className="h-3.5 w-3.5" />
                Accept
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ── Error phase ── */}
      {phase === "error" && (
        <>
          <p className="text-xs text-destructive bg-destructive/10 rounded px-2.5 py-2">
            {error}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={handleRetry}>
              Retry
            </Button>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
