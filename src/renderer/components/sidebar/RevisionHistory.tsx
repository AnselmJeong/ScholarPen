import React, { useEffect, useState } from "react";
import type * as Y from "yjs";
import { ChevronDown, ChevronRight, FileText, History } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Text } from "@astryxdesign/core/Text";
import { rpc } from "../../rpc";
import { PanelActions, PanelError, PanelNote, PanelSection } from "./panel-kit";
import { buildResponseLetter, readRevisions, REVISIONS_MAP, type RevisionEntry, type RevisionStatus } from "../../../shared/collab/revision-log";
import { editLevelLabel } from "../../../shared/collab/writing";

const STATUS: Record<RevisionStatus, { label: string; variant: "info" | "success" | "warning" | "neutral" }> = {
  pending: { label: "Pending", variant: "info" },
  accepted: { label: "Accepted", variant: "success" },
  partial: { label: "Partly accepted", variant: "warning" },
  rejected: { label: "Rejected", variant: "neutral" },
  applied: { label: "Applied", variant: "success" },
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
    <PanelSection title="Revision history" icon={History} summary={`${entries.length} AI revisions`}>
      <PanelActions>
        <Button label="Export response to reviewers" size="sm" variant="secondary" isDisabled={!projectPath || !documentName}
          tooltip="Write each answered comment with the response and the revised text to exports/"
          icon={<FileText className="h-3 w-3" aria-hidden />} onClick={() => void exportLetter()} />
        <CheckboxInput label="include pending" size="sm" value={includePending} onChange={setIncludePending} />
      </PanelActions>
      {message && (message.error ? <PanelError>{message.text}</PanelError> : <PanelNote role="status" className="break-all">{message.text}</PanelNote>)}
      <ul className="space-y-1.5">
        {entries.map(entry => (
          <li key={entry.id} className="rounded-md border border-sidebar-border bg-background">
            <button type="button" onClick={() => setExpanded(value => value === entry.id ? null : entry.id)} aria-expanded={expanded === entry.id}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-sidebar-accent/60">
              {expanded === entry.id ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
              <Badge label={STATUS[entry.status].label} variant={STATUS[entry.status].variant} />
              <Text type="body" maxLines={1}>{entry.label}</Text>
              <span className="ml-auto shrink-0 font-mono-ui text-[11px] text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
            </button>
            {expanded === entry.id && (
              <div className="space-y-1.5 border-t border-sidebar-border px-2 py-1.5 text-xs leading-5">
                <PanelNote>
                  {entry.kind === "coordinated" ? "Coordinated revision" : "Comment revision"}
                  {entry.level ? ` · ${editLevelLabel(entry.level)} level` : ""} · {entry.paragraphs.length} paragraphs
                </PanelNote>
                {entry.summary && <p className="text-foreground">{entry.summary}</p>}
                {entry.items.map(item => (
                  <div key={item.threadId} className="border-l-2 border-border pl-2">
                    <p className="text-muted-foreground">{item.commentBy === "ai" ? "AI review" : "Comment"}: {item.comment}</p>
                    <p className={item.outcome === "needs-user" ? "text-amber-700 dark:text-amber-400" : "text-foreground"}>
                      {item.outcome === "needs-user" ? "Question: " : "Response: "}{item.response}
                    </p>
                  </div>
                ))}
                {entry.references?.length ? <PanelNote>References added: {entry.references.map(ref => `@${ref.citekey}`).join(", ")}</PanelNote> : null}
                {entry.paragraphs.map(paragraph => (
                  <details key={paragraph.blockId}>
                    <summary className="cursor-pointer text-muted-foreground">Changed paragraph</summary>
                    <p className="mt-1 text-red-700/80 line-through decoration-red-400/60 dark:text-red-300/80">{paragraph.before}</p>
                    <p className="mt-1 text-emerald-800 dark:text-emerald-300">{paragraph.after}</p>
                  </details>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}
