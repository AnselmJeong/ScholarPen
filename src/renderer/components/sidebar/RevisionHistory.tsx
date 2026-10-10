import React, { useEffect, useState } from "react";
import type * as Y from "yjs";
import { ChevronDown, ChevronRight, FileText, History } from "lucide-react";
import { rpc } from "../../rpc";
import { cn } from "../../lib/utils";
import { buildResponseLetter, readRevisions, REVISIONS_MAP, type RevisionEntry, type RevisionStatus } from "../../../shared/collab/revision-log";
import { editLevelLabel } from "../../../shared/collab/writing";

const STATUS: Record<RevisionStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-blue-500/10 text-blue-700" },
  accepted: { label: "Accepted", className: "bg-emerald-500/10 text-emerald-700" },
  partial: { label: "Partly accepted", className: "bg-amber-500/10 text-amber-700" },
  rejected: { label: "Rejected", className: "bg-muted text-muted-foreground" },
  applied: { label: "Applied", className: "bg-emerald-500/10 text-emerald-700" },
};

function useRevisions(ydoc: Y.Doc) {
  const [entries, setEntries] = useState<RevisionEntry[]>([]);
  useEffect(() => {
    const map = ydoc.getMap<RevisionEntry>(REVISIONS_MAP);
    const refresh = () => setEntries(readRevisions(map));
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [ydoc]);
  return entries;
}

export function responseLetterFilename(documentName: string) {
  return `${documentName.replace(/\.scholarpen\.json$/, "").replace(/[^\p{L}\p{N}._-]+/gu, "-")}-response-to-reviewers.md`;
}

/** Every AI revision of this document: what was asked, the answer, the new text and the author's decision. */
export function RevisionHistory({ ydoc, documentName, projectPath, onExported }: {
  ydoc: Y.Doc;
  documentName: string | null;
  projectPath?: string;
  onExported?: () => Promise<void>;
}) {
  const entries = useRevisions(ydoc);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [includePending, setIncludePending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  if (!entries.length) return null;

  const exportLetter = async () => {
    if (!projectPath || !documentName) return;
    setMessage(null);
    try {
      const letter = buildResponseLetter(entries, documentName, { includePending });
      const path = await rpc.exportFile(projectPath, responseLetterFilename(documentName), letter.markdown);
      setMessage({ text: `${letter.addressed} responses${letter.open ? `, ${letter.open} open questions` : ""} saved: ${path}`, error: false });
      await onExported?.();
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : String(error), error: true }); }
  };

  return (
    <div className="border-b border-border">
      <button type="button" onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[11px] font-medium text-foreground hover:bg-muted/50">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <History className="h-3 w-3" /> Revision history
        <span className="ml-1 font-normal text-muted-foreground">{entries.length} AI revisions</span>
      </button>
      {open && (
        <div className="px-3 pb-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void exportLetter()} disabled={!projectPath || !documentName}
              title="Write each answered comment with the response and the revised text to exports/"
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40">
              <FileText className="h-3 w-3" /> Export response to reviewers
            </button>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={includePending} onChange={event => setIncludePending(event.currentTarget.checked)} />
              include pending
            </label>
          </div>
          {message && <p role={message.error ? "alert" : "status"} className={cn("mb-2 break-all text-[11px]", message.error ? "text-red-600" : "text-muted-foreground")}>{message.text}</p>}
          <ul className="space-y-1.5">
            {entries.map(entry => (
              <li key={entry.id} className="rounded border border-border">
                <button type="button" onClick={() => setExpanded(value => value === entry.id ? null : entry.id)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-muted/50">
                  <span className={cn("rounded-full px-1.5 py-px text-[10px]", STATUS[entry.status].className)}>{STATUS[entry.status].label}</span>
                  <span className="truncate text-foreground">{entry.label}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
                </button>
                {expanded === entry.id && (
                  <div className="space-y-1.5 border-t border-border px-2 py-1.5 text-[11px] leading-4">
                    <p className="text-muted-foreground">
                      {entry.kind === "coordinated" ? "Coordinated revision" : "Comment revision"}
                      {entry.level ? ` · ${editLevelLabel(entry.level)} level` : ""} · {entry.paragraphs.length} paragraphs
                    </p>
                    {entry.summary && <p className="text-foreground">{entry.summary}</p>}
                    {entry.items.map(item => (
                      <div key={item.threadId} className="border-l-2 border-border pl-2">
                        <p className="text-muted-foreground">{item.commentBy === "ai" ? "AI review" : "Comment"}: {item.comment}</p>
                        <p className={item.outcome === "needs-user" ? "text-amber-700" : "text-foreground"}>
                          {item.outcome === "needs-user" ? "Question: " : "Response: "}{item.response}
                        </p>
                      </div>
                    ))}
                    {entry.references?.length ? <p className="text-muted-foreground">References added: {entry.references.map(ref => `@${ref.citekey}`).join(", ")}</p> : null}
                    {entry.paragraphs.map(paragraph => (
                      <details key={paragraph.blockId}>
                        <summary className="cursor-pointer text-muted-foreground">Changed paragraph</summary>
                        <p className="mt-1 text-red-700/80 line-through decoration-red-400/60">{paragraph.before}</p>
                        <p className="mt-1 text-emerald-800 dark:text-emerald-300">{paragraph.after}</p>
                      </details>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
