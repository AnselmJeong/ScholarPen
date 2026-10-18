import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { ArrowLeft, Bot, Check, ChevronDown, ChevronRight, Copy, FileClock, History as HistoryIcon, Pencil, Pin, RotateCcw, User, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { onCollabHistoryChanged, rpc } from "../../rpc";
import { getEditorCollab } from "../../collab/editor-collab";
import { asCheckpoint, currentTexts, readVersion, restoreBlock, restoreDocument } from "../../collab/history-restore";
import {
  diffBlocks,
  groupHistory,
  sumStats,
  type DiffRow,
  type HistoryEntry,
  type HistoryGroup,
  type HistoryStats,
} from "../../../shared/collab/history";

type Editor = BlockNoteEditor<any, any, any>;
type Version = ReturnType<typeof readVersion>;
type Mode = "step" | "since";

const EMPTY_VERSION: Version = { blocks: [], texts: [] };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(at: number) {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString([], { year: day.getFullYear() === today.getFullYear() ? undefined : "numeric", month: "short", day: "numeric", weekday: "short" });
}

/** "Oct 18, 14:32" for labels that outlive the day they were written. */
function moment(at: number) {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function entryTitle(entry: HistoryEntry) {
  switch (entry.kind) {
    case "ai": return entry.label ? `ScholarPen AI · ${entry.label}` : "ScholarPen AI edit";
    case "start": return entry.label ?? "History started";
    case "restore": return entry.label ?? "Restored an earlier version";
    case "outside": return "Changes made while history was off";
    case "system": return entry.label ?? "Automatic update";
    default: return entry.label ?? "Your edits";
  }
}

function EntryIcon({ entry, className }: { entry: HistoryEntry; className?: string }) {
  const Icon = entry.kind === "ai" ? Bot
    : entry.kind === "restore" ? RotateCcw
      : entry.kind === "start" ? FileClock
        : entry.kind === "author" ? User : HistoryIcon;
  return <Icon className={cn("h-3 w-3 shrink-0", entry.kind === "ai" ? "text-violet-600" : "text-muted-foreground", className)} />;
}

function StatsLine({ stats }: { stats: HistoryStats }) {
  return (
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {stats.added > 0 && <span className="text-emerald-700 dark:text-emerald-400">+{stats.added}</span>}
      {stats.added > 0 && stats.removed > 0 && " "}
      {stats.removed > 0 && <span className="text-red-700 dark:text-red-400">−{stats.removed}</span>}
      {stats.added === 0 && stats.removed === 0 && `${stats.blocks} ¶`}
    </span>
  );
}

function useHistoryEntries(docKey: string | null, active: boolean) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++request.current;
    if (!docKey) {
      setEntries(null);
      return;
    }
    rpc.collabHistoryList(docKey)
      .then((list) => {
        if (seq !== request.current) return;
        setEntries(list ?? []);
        setError(null);
      })
      .catch((cause) => { if (seq === request.current) setError(errorText(cause)); });
  }, [docKey]);
  useEffect(() => { setEntries(null); }, [docKey]);
  useEffect(() => { if (active) refresh(); }, [active, refresh]);
  useEffect(() => onCollabHistoryChanged((key) => { if (key === docKey && active) refresh(); }), [docKey, active, refresh]);
  return { entries, error, refresh };
}

/** The accepted text of the open document, kept current while it is edited. */
function useCurrentTexts(editor: Editor, enabled: boolean) {
  const [texts, setTexts] = useState(() => (enabled ? currentTexts(editor) : []));
  useEffect(() => {
    if (!enabled) return;
    setTexts(currentTexts(editor));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = editor.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTexts(currentTexts(editor)), 400);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [editor, enabled]);
  return texts;
}

function NameForm({ initial, placeholder, onSave, onCancel }: {
  initial: string;
  placeholder: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); onSave(value); }}>
      <input autoFocus value={value} onChange={(event) => setValue(event.currentTarget.value)} placeholder={placeholder}
        onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
        className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:border-primary" />
      <button type="submit" aria-label="Save name" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <Check className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Cancel" onClick={onCancel} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}

function GroupRow({ group, expanded, onToggle, onSelect }: {
  group: HistoryGroup;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (entry: HistoryEntry) => void;
}) {
  const { head } = group;
  if (group.entries.length === 1) {
    return (
      <button type="button" onClick={() => onSelect(head)}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] hover:bg-muted/60">
        <span className="w-9 shrink-0 tabular-nums text-muted-foreground">{clock(head.endedAt)}</span>
        <EntryIcon entry={head} />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {head.name && <Pin className="mr-1 inline h-3 w-3 text-amber-600" />}
          {head.name ? <span className="font-medium">{head.name}</span> : entryTitle(head)}
          {head.name && <span className="text-muted-foreground"> · {entryTitle(head)}</span>}
        </span>
        <StatsLine stats={head.stats} />
      </button>
    );
  }
  const first = group.entries[0];
  return (
    <div>
      <div className="flex w-full items-center gap-1.5 px-3 py-1 text-[11px] hover:bg-muted/60">
        <button type="button" onClick={onToggle} aria-label={expanded ? "Collapse" : "Expand"} className="text-muted-foreground">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => onSelect(head)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="shrink-0 tabular-nums text-muted-foreground">{clock(first.startedAt)}–{clock(head.endedAt)}</span>
          <User className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">
            Your edits <span className="text-muted-foreground">· {group.entries.length} checkpoints</span>
          </span>
          <StatsLine stats={sumStats(group.entries)} />
        </button>
      </div>
      {expanded && [...group.entries].reverse().map((entry) => (
        <button key={entry.id} type="button" onClick={() => onSelect(entry)}
          className="flex w-full items-center gap-1.5 py-0.5 pl-8 pr-3 text-left text-[11px] text-muted-foreground hover:bg-muted/60">
          <span className="w-9 shrink-0 tabular-nums">{clock(entry.endedAt)}</span>
          <span className="min-w-0 flex-1 truncate">{entry.merged && entry.merged > 1 ? `${entry.merged} checkpoints` : "Checkpoint"}</span>
          <StatsLine stats={entry.stats} />
        </button>
      ))}
    </div>
  );
}

function DiffText({ row }: { row: DiffRow }) {
  const heading = row.type === "heading";
  const className = cn("whitespace-pre-wrap break-words", heading && "font-semibold");
  if (row.kind === "changed") {
    return (
      <p className={className}>
        {row.parts.map((part, index) => part.op === "same" ? <span key={index}>{part.text}</span>
          : part.op === "add"
            ? <ins key={index} className="rounded-sm bg-emerald-500/15 text-emerald-900 no-underline dark:text-emerald-200">{part.text}</ins>
            : <del key={index} className="rounded-sm bg-red-500/10 text-red-800 decoration-red-500/60 dark:text-red-300">{part.text}</del>)}
        {row.parts.every((part) => part.op === "same") && <span className="ml-1 text-muted-foreground">(formatting)</span>}
      </p>
    );
  }
  const text = row.text || `[${row.type}]`;
  if (row.kind === "added") return <p className={cn(className, "text-emerald-900 dark:text-emerald-200")}>{text}</p>;
  if (row.kind === "removed") return <p className={cn(className, "text-red-800 line-through decoration-red-500/60 dark:text-red-300")}>{text}</p>;
  return <p className={cn(className, "text-muted-foreground")}>{text}</p>;
}

function VersionDetail({ editor, docKey, entries, entry, loadVersion, onBack }: {
  editor: Editor;
  docKey: string;
  entries: HistoryEntry[];
  entry: HistoryEntry;
  loadVersion: (entryId: string) => Promise<Version>;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<Mode>("step");
  const [version, setVersion] = useState<Version | null>(null);
  const [before, setBefore] = useState<Version | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [naming, setNaming] = useState(false);
  const [showSame, setShowSame] = useState(false);
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const current = useCurrentTexts(editor, mode === "since");
  const at = entries.findIndex((item) => item.id === entry.id);
  const previous = at > 0 ? entries[at - 1] : null;

  useEffect(() => {
    let cancelled = false;
    setVersion(null);
    setBefore(null);
    setError(null);
    setStatus(null);
    setRestored(new Set());
    Promise.all([loadVersion(entry.id), previous ? loadVersion(previous.id) : Promise.resolve(EMPTY_VERSION)])
      .then(([after, prior]) => {
        if (cancelled) return;
        setVersion(after);
        setBefore(prior);
      })
      .catch((cause) => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [entry.id, previous?.id, loadVersion]);

  const older = mode === "step" ? before : version;
  const olderAt = mode === "step" ? previous?.endedAt ?? entry.startedAt : entry.endedAt;
  const rows = useMemo(() => {
    if (!version || !before) return null;
    return mode === "step" ? diffBlocks(before.texts, version.texts) : diffBlocks(version.texts, current);
  }, [mode, version, before, current]);

  const restoreAll = () => {
    if (!version) return;
    setConfirming(false);
    const changed = asCheckpoint(editor, `Restored the version of ${moment(entry.endedAt)}`,
      () => restoreDocument(editor, version.blocks), "restore");
    setStatus(changed ? "Restored. The text it replaced stays in History." : "The document already matches this version.");
  };

  const restoreRow = (blockId: string) => {
    if (!older) return;
    const done = asCheckpoint(editor, `Restored a paragraph from ${moment(olderAt)}`,
      () => restoreBlock(editor, older.blocks, blockId), "restore");
    if (done) setRestored((ids) => new Set(ids).add(blockId));
    else setStatus("This paragraph could not be restored.");
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => setStatus("Copied.")).catch(() => setStatus("Could not copy."));
  };

  const rename = (name: string) => {
    setNaming(false);
    rpc.collabHistoryName(docKey, name, entry.id).catch((cause) => setStatus(errorText(cause)));
  };

  const changes = rows?.filter((row) => row.kind !== "same").length ?? 0;
  const visibleRows: Array<DiffRow | { kind: "gap"; count: number; id: string }> = [];
  for (const row of rows ?? []) {
    if (row.kind === "same" && !showSame) {
      const last = visibleRows.at(-1);
      if (last?.kind === "gap") last.count++;
      else visibleRows.push({ kind: "gap", count: 1, id: `gap-${row.id}` });
    } else visibleRows.push(row);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b border-border px-3 py-2">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> All versions
        </button>
        <div className="flex items-start gap-1.5 text-xs">
          <EntryIcon entry={entry} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            {naming ? (
              <NameForm initial={entry.name ?? ""} placeholder="Version name" onSave={rename} onCancel={() => setNaming(false)} />
            ) : (
              <p className="break-words font-medium text-foreground">
                {entry.name && <Pin className="mr-1 inline h-3 w-3 text-amber-600" />}
                {entry.name ?? entryTitle(entry)}
                <button type="button" onClick={() => setNaming(true)} aria-label="Name this version"
                  className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground">
                  <Pencil className="h-3 w-3" />
                </button>
              </p>
            )}
            {entry.name && <p className="break-words text-[11px] text-muted-foreground">{entryTitle(entry)}</p>}
            <p className="text-[11px] text-muted-foreground">
              {moment(entry.endedAt)}{entry.merged && entry.merged > 1 ? ` · ${entry.merged} checkpoints` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex rounded border border-border p-px text-[11px]">
            {(["step", "since"] as const).map((value) => (
              <button key={value} type="button" onClick={() => setMode(value)}
                title={value === "step" ? "What this checkpoint changed" : "What changed between this version and now"}
                className={cn("rounded-sm px-1.5 py-0.5", mode === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {value === "step" ? "This change" : "Since then"}
              </button>
            ))}
          </div>
          {confirming ? (
            <span className="flex items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">Replace the current text?</span>
              <button type="button" onClick={restoreAll} className="rounded bg-primary px-1.5 py-0.5 text-primary-foreground hover:bg-primary/90">Restore</button>
              <button type="button" onClick={() => setConfirming(false)} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted">Cancel</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={!version}
              className="ml-auto flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-40">
              <RotateCcw className="h-3 w-3" /> Restore this version
            </button>
          )}
        </div>
        {status && <p role="status" className="text-[11px] text-muted-foreground">{status}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs leading-5">
        {error && <p role="alert" className="text-red-600">{error}</p>}
        {!error && !rows && <p className="text-muted-foreground">Loading…</p>}
        {rows && changes === 0 && (
          <p className="mb-2 text-muted-foreground">
            {mode === "step" ? "This checkpoint changed no text." : "The document still matches this version."}
          </p>
        )}
        <div className="space-y-2">
          {visibleRows.map((row) => {
            if (row.kind === "gap") {
              return (
                <button key={row.id} type="button" onClick={() => setShowSame(true)}
                  className="block w-full rounded border border-dashed border-border px-2 py-0.5 text-center text-[11px] text-muted-foreground hover:bg-muted/50">
                  {row.count} unchanged {row.count === 1 ? "paragraph" : "paragraphs"}
                </button>
              );
            }
            const olderText = row.kind === "changed" ? row.older : row.kind === "removed" ? row.text : null;
            return (
              <div key={`${row.kind}-${row.id}`} className={cn("group rounded px-2 py-1",
                row.kind === "added" && "bg-emerald-500/5", row.kind === "removed" && "bg-red-500/5", row.kind === "changed" && "bg-muted/40")}>
                <DiffText row={row} />
                {olderText !== null && (
                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                    {restored.has(row.id) ? (
                      <span className="flex items-center gap-1 text-emerald-700"><Check className="h-3 w-3" /> Restored</span>
                    ) : (
                      <button type="button" onClick={() => restoreRow(row.id)}
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                        <RotateCcw className="h-3 w-3" /> {row.kind === "removed" ? "Restore paragraph" : "Restore earlier text"}
                      </button>
                    )}
                    <button type="button" onClick={() => copy(olderText)}
                      className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                      <Copy className="h-3 w-3" /> Copy earlier text
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {showSame && rows && rows.some((row) => row.kind === "same") && (
          <button type="button" onClick={() => setShowSame(false)} className="mt-2 text-[11px] text-muted-foreground hover:text-foreground">
            Hide unchanged paragraphs
          </button>
        )}
      </div>
    </div>
  );
}

/** The document's version history: checkpoints over time, each viewable, comparable and restorable. */
export function HistoryPanel({ editor, documentName, active }: {
  editor: Editor | null;
  documentName: string | null;
  active: boolean;
}) {
  const collab = editor ? getEditorCollab(editor) : null;
  const docKey = collab?.docKey ?? null;
  const { entries, error } = useHistoryEntries(docKey, active);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const versions = useRef(new Map<string, Promise<Version>>());

  useEffect(() => {
    versions.current = new Map();
    setSelected(null);
    setNaming(false);
    setMessage(null);
  }, [docKey]);

  const loadVersion = useCallback((entryId: string) => {
    if (!editor || !docKey) return Promise.resolve(EMPTY_VERSION);
    const cached = versions.current.get(entryId);
    if (cached) return cached;
    const loading = rpc.collabHistoryVersion(docKey, entryId).then((version) => {
      if (!version) throw new Error("This version is no longer in the history.");
      return readVersion(editor, version.doc);
    });
    loading.catch(() => versions.current.delete(entryId));
    versions.current.set(entryId, loading);
    return loading;
  }, [editor, docKey]);

  const groups = useMemo(() => groupHistory(entries ?? []), [entries]);

  if (!editor || !collab || !docKey) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Open a document to see its history.
      </div>
    );
  }

  const selectedEntry = selected ? entries?.find((entry) => entry.id === selected) ?? null : null;
  if (selectedEntry && entries) {
    return (
      <VersionDetail editor={editor} docKey={docKey} entries={entries} entry={selectedEntry}
        loadVersion={loadVersion} onBack={() => setSelected(null)} />
    );
  }

  const saveVersion = (name: string) => {
    setNaming(false);
    if (!name.trim()) return;
    collab.afterPushes(() => rpc.collabHistoryName(docKey, name))
      .then((entry) => setMessage(entry ? `Saved “${entry.name}”.` : "Nothing to name yet."))
      .catch((cause) => setMessage(errorText(cause)));
  };

  let lastDay = "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          <HistoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="mr-auto truncate text-xs font-medium text-foreground">
            History{documentName ? ` · ${documentName.replace(".scholarpen.json", "")}` : ""}
          </span>
          {!naming && (
            <button type="button" onClick={() => setNaming(true)}
              title="Give the current text a name you can come back to"
              className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted">
              <Pin className="h-3 w-3" /> Save version
            </button>
          )}
        </div>
        {naming && <NameForm initial="" placeholder="e.g. Submitted to journal" onSave={saveVersion} onCancel={() => setNaming(false)} />}
        <p className="text-[11px] leading-4 text-muted-foreground">
          A checkpoint is kept when you pause writing, around every AI edit and when you accept suggestions.
        </p>
        {message && <p role="status" className="text-[11px] text-muted-foreground">{message}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error && <p role="alert" className="px-3 py-1 text-xs text-red-600">{error}</p>}
        {!entries && !error && <p className="px-3 py-1 text-xs text-muted-foreground">Loading…</p>}
        {entries?.length === 0 && <p className="px-3 py-1 text-xs text-muted-foreground">No checkpoints yet. Start writing.</p>}
        {groups.map((group) => {
          const day = dayLabel(group.head.endedAt);
          const heading = day !== lastDay ? day : null;
          lastDay = day;
          const key = group.entries[0].id;
          return (
            <React.Fragment key={key}>
              {heading && <p className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{heading}</p>}
              <GroupRow group={group} expanded={expanded.has(key)} onSelect={(entry) => setSelected(entry.id)}
                onToggle={() => setExpanded((keys) => {
                  const next = new Set(keys);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })} />
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
