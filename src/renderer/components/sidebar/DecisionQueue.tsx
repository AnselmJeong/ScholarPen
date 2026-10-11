import React, { useState } from "react";
import type * as Y from "yjs";
import { HelpCircle, Send, User } from "lucide-react";
import type { ThreadSnapshot } from "../../../shared/collab/threads";
import { answerDecision, answerDecisionsTogether, dismissDecision, openDecisions } from "../../../shared/collab/decisions";
import type { EditLevel } from "../../../shared/collab/writing";

/**
 * Questions ScholarPen AI needs the author to answer. Each answer goes back
 * to the AI on its thread, or all answers go into one coordinated revision.
 */
export function DecisionQueue({ ydoc, threads, level, reference, onSelect, blocked }: {
  ydoc: Y.Doc;
  threads: ThreadSnapshot[];
  level: EditLevel;
  reference: (threadId: string) => string | null;
  onSelect: (threadId: string) => void;
  /** Why a coordinated revision cannot start now (pending suggestions), if so. */
  blocked?: string | null;
}) {
  const decisions = openDecisions(threads);
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  if (!decisions.length) return null;
  const answered = decisions.filter(thread => answers.get(thread.id)?.trim());

  const run = (action: () => void, clear: string[]) => {
    setError(null);
    try {
      action();
      setAnswers(previous => {
        const next = new Map(previous);
        for (const id of clear) next.delete(id);
        return next;
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return (
    <section className="border-b border-border bg-amber-500/5 px-3 py-2" aria-label="Decisions for you">
      <h3 className="mb-1 flex items-center gap-1 text-[11px] font-medium text-foreground">
        <HelpCircle className="h-3 w-3 text-amber-600" /> Decisions for you · {decisions.length}
      </h3>
      <ul className="space-y-2">
        {decisions.map(thread => {
          const quoted = thread.meta.scope === "document" ? "Whole manuscript" : reference(thread.id);
          return (
            <li key={thread.id} className="rounded border border-border bg-background p-2">
              {quoted && (
                <button type="button" onClick={() => onSelect(thread.id)}
                  className="mb-1 block w-full truncate border-l-2 border-amber-400/70 pl-2 text-left text-[11px] text-muted-foreground hover:text-foreground">
                  {quoted}
                </button>
              )}
              <p className="text-xs leading-5 text-foreground">{thread.meta.decision!.question}</p>
              <textarea value={answers.get(thread.id) ?? ""} rows={2} aria-label="Your answer"
                onChange={event => { const value = event.currentTarget.value; setAnswers(previous => new Map(previous).set(thread.id, value)); }}
                placeholder="Your decision, evidence or source…"
                className="mt-1 w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs" />
              <div className="mt-1 flex gap-1">
                <button type="button" disabled={!answers.get(thread.id)?.trim()}
                  onClick={() => run(() => answerDecision(ydoc, thread.id, answers.get(thread.id) ?? ""), [thread.id])}
                  className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-40">
                  <Send className="h-3 w-3" /> Answer · AI continues
                </button>
                <button type="button" onClick={() => run(() => dismissDecision(ydoc, thread.id), [thread.id])}
                  className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
                  <User className="h-3 w-3" /> I'll handle it
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {decisions.length > 1 && (
        <button type="button" disabled={!answered.length || !!blocked} title={blocked ?? undefined}
          onClick={() => run(() => answerDecisionsTogether(ydoc, new Map(answered.map(thread => [thread.id, answers.get(thread.id)!])), level),
            answered.map(thread => thread.id))}
          className="mt-2 flex items-center gap-1 rounded border border-amber-600/30 px-2 py-1 text-[11px] text-amber-800 hover:bg-amber-500/10 disabled:opacity-40 dark:text-amber-300">
          <Send className="h-3 w-3" /> Send {answered.length || ""} answers · one coordinated revision
        </button>
      )}
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
    </section>
  );
}
