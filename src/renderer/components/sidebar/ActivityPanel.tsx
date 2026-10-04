import React, { useEffect, useMemo, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { BellOff, Bot, Check, CircleDot, MessageSquare, RotateCcw, User, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import {
  AI_USER_ID,
  readThreads,
  updateThreadMeta,
  type ThreadSnapshot,
  type ThreadStatus,
} from "../../../shared/collab/threads";
import { getEditorCollab } from "../../collab/editor-collab";
import { REVIEW_CATEGORY_LABEL, REVIEW_MAP } from "../../../shared/collab/review";
import { AIActivitySection } from "./AIActivitySection";
import { ZonesSection } from "./ZonesSection";

type Filter = "open" | "ai" | "mine" | "resolved";

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: "Open",
  "in-progress": "AI working",
  proposed: "Proposed",
  resolved: "Resolved",
};

function threadStatus(thread: ThreadSnapshot): ThreadStatus {
  if (thread.resolved) return "resolved";
  return thread.meta.status ?? "open";
}

function useThreads(editor: BlockNoteEditor<any, any, any> | null) {
  const [threads, setThreads] = useState<ThreadSnapshot[]>([]);
  useEffect(() => {
    const collab = editor ? getEditorCollab(editor) : null;
    if (!collab) {
      setThreads([]);
      return;
    }
    const map = collab.ydoc.getMap(COLLAB_THREADS_MAP);
    const refresh = () => setThreads(readThreads(map));
    refresh();
    map.observeDeep(refresh);
    return () => map.unobserveDeep(refresh);
  }, [editor]);
  return threads;
}

function useThreadPositions(editor: BlockNoteEditor<any, any, any> | null) {
  const [positions, setPositions] = useState<Map<string, { from: number; to: number }>>(new Map());
  useEffect(() => {
    const comments = editor?.getExtension(CommentsExtension);
    if (!comments) return;
    setPositions(comments.store.state.threadPositions);
    return comments.store.subscribe(() => setPositions(comments.store.state.threadPositions));
  }, [editor]);
  return positions;
}

interface ActivityPanelProps {
  editor: BlockNoteEditor<any, any, any> | null;
  documentName: string | null;
  /** Rendered above the thread list (AI work queue, pending suggestions). */
  children?: React.ReactNode;
}

export function ActivityPanel({ editor, documentName, children }: ActivityPanelProps) {
  const threads = useThreads(editor);
  const positions = useThreadPositions(editor);
  const [filter, setFilter] = useState<Filter>("open");
  const collab = editor ? getEditorCollab(editor) : null;

  const visible = useMemo(() => {
    const filtered = threads.filter((thread) => {
      const status = threadStatus(thread);
      if (filter === "resolved") return status === "resolved";
      if (status === "resolved") return false;
      if (filter === "ai") return thread.meta.assignee === "ai" || thread.comments[0]?.userId === AI_USER_ID;
      if (filter === "mine") return thread.meta.assignee === "me";
      return true;
    });
    return filtered.sort((a, b) =>
      (positions.get(a.id)?.from ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id)?.from ?? Number.MAX_SAFE_INTEGER));
  }, [threads, filter, positions]);

  const counts = useMemo(() => ({
    open: threads.filter((t) => threadStatus(t) !== "resolved").length,
    ai: threads.filter((t) => threadStatus(t) !== "resolved" &&
      (t.meta.assignee === "ai" || t.comments[0]?.userId === AI_USER_ID)).length,
    mine: threads.filter((t) => threadStatus(t) !== "resolved" && t.meta.assignee === "me").length,
    resolved: threads.filter((t) => threadStatus(t) === "resolved").length,
  }), [threads]);

  const setMeta = (threadId: string, patch: Parameters<typeof updateThreadMeta>[2]) => {
    if (!collab) return;
    collab.ydoc.transact(() => updateThreadMeta(collab.ydoc.getMap(COLLAB_THREADS_MAP), threadId, patch));
  };

  const referenceText = (threadId: string) => {
    const position = positions.get(threadId);
    const doc = editor?.prosemirrorView?.state.doc;
    if (!position || !doc) return null;
    const to = Math.min(position.to, doc.content.size);
    return doc.textBetween(Math.max(0, position.from), to, " ", " ").trim().slice(0, 140);
  };

  if (!editor || !collab) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Open a document to see its comments and AI activity.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AIActivitySection editor={editor} />
      <ZonesSection editor={editor} />
      {children}
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="mr-auto truncate text-xs font-medium text-foreground">
          Comments{documentName ? ` · ${documentName.replace(".scholarpen.json", "")}` : ""}
        </span>
        {(["open", "ai", "mine", "resolved"] as Filter[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px] capitalize",
              filter === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {value === "ai" ? "AI" : value} {counts[value] > 0 ? counts[value] : ""}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <p className="p-4 text-xs leading-5 text-muted-foreground">
            {filter === "open"
              ? "No open threads. Select text and use the comment button. Mention @AI or assign a thread to the AI to have it revise that passage."
              : "Nothing here."}
          </p>
        )}
        {visible.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            reference={referenceText(thread.id)}
            onSelect={() => editor.getExtension(CommentsExtension)?.selectThread(thread.id)}
            onAssign={(assignee) => setMeta(thread.id, {
              assignee, status: "open", statusNote: undefined, ...(assignee === "ai" ? { requestedAt: Date.now() } : {}),
            })}
            onResolve={() => setMeta(thread.id, { status: "resolved" })}
            onMute={thread.meta.category ? () => {
              const map = collab.ydoc.getMap(REVIEW_MAP);
              collab.ydoc.transact(() => {
                const muted = (map.get("muted") as string[] | undefined) ?? [];
                if (!muted.includes(thread.meta.category!)) map.set("muted", [...muted, thread.meta.category!]);
                updateThreadMeta(collab.ydoc.getMap(COLLAB_THREADS_MAP), thread.id, { status: "resolved", muted: true });
              });
            } : undefined}
            onReopen={() => setMeta(thread.id, { status: "open" })}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadRow({ thread, reference, onSelect, onAssign, onResolve, onReopen, onMute }: {
  thread: ThreadSnapshot;
  reference: string | null;
  onSelect: () => void;
  onAssign: (assignee: "ai" | "me") => void;
  onResolve: () => void;
  onReopen: () => void;
  /** Resolves an AI review finding and stops the reviewer raising its category. */
  onMute?: () => void;
}) {
  const status = threadStatus(thread);
  const first = thread.comments.find((comment) => !comment.deleted);
  const fromAI = first?.userId === AI_USER_ID;
  const replies = thread.comments.filter((comment) => !comment.deleted).length - 1;
  const last = [...thread.comments].reverse().find((comment) => !comment.deleted);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter") onSelect(); }}
      className="group cursor-pointer border-b border-border px-3 py-2.5 hover:bg-muted/50"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px]">
        {fromAI ? <Bot className="h-3 w-3 text-violet-600" /> : <User className="h-3 w-3 text-blue-600" />}
        <span className="font-medium text-foreground">{fromAI ? "ScholarPen AI" : "You"}</span>
        {thread.meta.severity && (
          <span className={cn("rounded px-1 text-[10px]",
            thread.meta.severity === "high" ? "bg-red-500/10 text-red-600"
              : thread.meta.severity === "medium" ? "bg-amber-500/10 text-amber-700" : "bg-muted text-muted-foreground")}>
            {REVIEW_CATEGORY_LABEL[thread.meta.category ?? ""] ?? thread.meta.category ?? thread.meta.severity}
          </span>
        )}
        <span className={cn("ml-auto flex items-center gap-1 rounded-full px-1.5 py-px text-[10px]",
          status === "in-progress" ? "bg-violet-500/10 text-violet-700"
            : status === "proposed" ? "bg-emerald-500/10 text-emerald-700"
              : status === "resolved" ? "bg-muted text-muted-foreground" : "bg-blue-500/10 text-blue-700")}>
          {status === "in-progress" && <CircleDot className="h-2.5 w-2.5 animate-pulse" />}
          {STATUS_LABEL[status]}
          {thread.meta.assignee && status !== "resolved" && ` · ${thread.meta.assignee === "ai" ? "AI" : "you"}`}
        </span>
      </div>
      {reference && (
        <p className="mb-1 truncate border-l-2 border-amber-400/70 pl-2 text-[11px] text-muted-foreground">{reference}</p>
      )}
      <p className="line-clamp-3 text-xs leading-5 text-foreground">{first?.text || "(empty comment)"}</p>
      {replies > 0 && last && last !== first && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          <span className="font-medium">{last.userId === AI_USER_ID ? "AI" : "You"}:</span> {last.text}
        </p>
      )}
      {thread.meta.statusNote && status !== "resolved" && (
        <p className="mt-1 text-[11px] italic leading-4 text-muted-foreground">{thread.meta.statusNote}</p>
      )}
      <div className="mt-1.5 flex gap-1 opacity-70 group-hover:opacity-100" onClick={(event) => event.stopPropagation()}>
        {status === "resolved" ? (
          <SmallButton icon={<RotateCcw className="h-3 w-3" />} label="Reopen" onClick={onReopen} />
        ) : (
          <>
            {thread.meta.assignee !== "ai" && (
              <SmallButton icon={<Bot className="h-3 w-3" />} label="Ask AI" onClick={() => onAssign("ai")} />
            )}
            {thread.meta.assignee !== "me" && (
              <SmallButton icon={<User className="h-3 w-3" />} label="I'll handle" onClick={() => onAssign("me")} />
            )}
            <SmallButton icon={<Check className="h-3 w-3" />} label="Resolve" onClick={onResolve} />
            {onMute && fromAI && (
              <SmallButton icon={<BellOff className="h-3 w-3" />} label="Stop flagging this" onClick={onMute} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SmallButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {icon}
      {label}
    </button>
  );
}

export function ActivityPanelHeader({ tab, onTab, onClose }: {
  tab: "activity" | "assistant";
  onTab: (tab: "activity" | "assistant") => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      {(["activity", "assistant"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onTab(value)}
          className={cn("rounded px-2 py-1 text-xs font-medium",
            tab === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {value === "activity" ? "Activity" : "Assistant"}
        </button>
      ))}
      <button type="button" onClick={onClose} aria-label="Close panel"
        className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
