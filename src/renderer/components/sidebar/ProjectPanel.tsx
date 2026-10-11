import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, FileSearch, Map as MapIcon, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { rpc } from "../../rpc";
import { cn } from "../../lib/utils";
import { normalizeGlossary, type Glossary, type GlossaryEntry } from "../../../shared/glossary";
import type { ManuscriptMapView, ProjectJobStatus } from "../../../shared/manuscript-map";
import { CONSISTENCY_KIND_LABEL, type ConsistencyView } from "../../../shared/consistency-report";

const POLL_MS = 2_000;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function Section({ title, icon, summary, children, defaultOpen = false }: {
  title: string; icon: React.ReactNode; summary?: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
        className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/50">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon} {title}
        {summary && <span className="ml-1 truncate font-normal text-muted-foreground">{summary}</span>}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

function JobLine({ job }: { job: ProjectJobStatus }) {
  if (job.state === "running") return <p role="status" className="mt-1 text-[11px] text-violet-700">{job.detail ?? "Working…"}</p>;
  if (job.state === "failed") return <p role="alert" className="mt-1 break-words text-[11px] text-red-600">{job.error}</p>;
  return null;
}

/** Polls a project job view while its job runs. */
function useProjectJob<T extends { job: ProjectJobStatus }>(projectPath: string, load: (projectPath: string) => Promise<T>) {
  const [view, setView] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => load(projectPath).then(next => { setView(next); setError(null); }).catch(reason => setError(errorText(reason))),
    [load, projectPath]);
  useEffect(() => { setView(null); void refresh(); }, [refresh]);
  useEffect(() => {
    if (view?.job.state !== "running") return;
    const timer = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(timer);
  }, [view, refresh]);
  return { view, setView, error, setError, refresh };
}

const emptyEntry = (): GlossaryEntry => ({ term: "" });

function GlossaryEditor({ projectPath, suggestions }: { projectPath: string; suggestions: Array<{ term: string; definition: string }> }) {
  const [saved, setSaved] = useState<Glossary | null>(null);
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    rpc.getGlossary(projectPath).then(glossary => {
      if (cancelled) return;
      setSaved(glossary);
      setEntries(glossary.entries);
    }).catch(reason => setError(errorText(reason)));
    return () => { cancelled = true; };
  }, [projectPath]);
  const dirty = saved !== null && JSON.stringify(normalizeGlossary({ entries }).entries) !== JSON.stringify(saved.entries);
  const known = new Set(entries.flatMap(entry => [entry.term.toLowerCase(), entry.abbreviation?.toLowerCase()]).filter(Boolean));
  const missing = suggestions.filter(item => !known.has(item.term.toLowerCase())).slice(0, 12);

  const patch = (index: number, change: Partial<GlossaryEntry>) =>
    setEntries(current => current.map((entry, at) => at === index ? { ...entry, ...change } : entry));
  const save = async () => {
    setError(null);
    try {
      const next = await rpc.saveGlossary(projectPath, { entries });
      setSaved(next);
      setEntries(next.entries);
      setStatus(`Saved ${next.entries.length} entries. AI edits and reviews use them from now on.`);
    } catch (reason) { setError(errorText(reason)); }
  };

  if (!saved) return error ? <p role="alert" className="text-[11px] text-red-600">{error}</p> : <p className="text-[11px] text-muted-foreground">Loading…</p>;
  return (
    <div>
      <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
        Binding terms for every document. AI edits use them, reviews flag avoided variants and abbreviations not spelled out at first use.
      </p>
      <ul className="space-y-2">
        {entries.map((entry, index) => (
          <li key={index} className="rounded border border-border p-2">
            <div className="flex gap-1">
              <input value={entry.term} onChange={event => patch(index, { term: event.currentTarget.value })} placeholder="Preferred term"
                aria-label="Preferred term" className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs" />
              <input value={entry.abbreviation ?? ""} onChange={event => patch(index, { abbreviation: event.currentTarget.value || undefined })}
                placeholder="Abbr." aria-label="Abbreviation" className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-xs" />
              <button type="button" aria-label="Remove entry" onClick={() => setEntries(current => current.filter((_, at) => at !== index))}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600"><Trash2 className="h-3 w-3" /></button>
            </div>
            <input value={entry.definition ?? ""} onChange={event => patch(index, { definition: event.currentTarget.value || undefined })}
              placeholder="Definition (optional)" aria-label="Definition"
              className="mt-1 w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs" />
            <input value={(entry.avoid ?? []).join(", ")} aria-label="Variants to avoid"
              onChange={event => patch(index, { avoid: event.currentTarget.value.split(",").map(part => part.trimStart()).filter((part, at, all) => part || at === all.length - 1) })}
              placeholder="Avoid, comma-separated (optional)"
              className="mt-1 w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs" />
            {entry.abbreviation && (
              <label className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <input type="checkbox" checked={!!entry.noExpansion} onChange={event => patch(index, { noExpansion: event.currentTarget.checked || undefined })} />
                well known, never spelled out
              </label>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => setEntries(current => [...current, emptyEntry()])}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted">
          <Plus className="h-3 w-3" /> Add term
        </button>
        <button type="button" onClick={() => void save()} disabled={!dirty}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40">
          <Save className="h-3 w-3" /> Save glossary
        </button>
      </div>
      {status && !dirty && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{status}</p>}
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
      {missing.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] text-muted-foreground">Terms the manuscript map found that the glossary does not have:</p>
          <ul className="flex flex-wrap gap-1">
            {missing.map(item => (
              <li key={item.term}>
                <button type="button" title={item.definition}
                  onClick={() => setEntries(current => [...current, { term: item.term, definition: item.definition }])}
                  className="flex items-center gap-0.5 rounded-full border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted">
                  <Plus className="h-2.5 w-2.5" /> {item.term}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ManuscriptMapSection({ map, onUpdate, onOpenDocument }: {
  map: ReturnType<typeof useProjectJob<ManuscriptMapView>>;
  onUpdate: () => void;
  onOpenDocument?: (filename: string) => void;
}) {
  const { view, error } = map;
  if (!view) return error ? <p role="alert" className="text-[11px] text-red-600">{error}</p> : <p className="text-[11px] text-muted-foreground">Loading…</p>;
  const stale = view.documents.filter(document => document.stale).length;
  return (
    <div>
      <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
        A digest of every document (summary, key claims, definitions, numbers) that AI work on one chapter reads to stay consistent with the others.
      </p>
      <button type="button" onClick={onUpdate} disabled={view.job.state === "running" || !view.documents.length}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40">
        <RefreshCw className={cn("h-3 w-3", view.job.state === "running" && "animate-spin")} />
        {stale ? `Update map · ${stale} changed` : "Map is up to date"}
      </button>
      <JobLine job={view.job} />
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
      <ul className="mt-2 space-y-2">
        {view.documents.map(({ filename, entry, stale: outdated }) => (
          <li key={filename} className="rounded border border-border p-2 text-[11px] leading-4">
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => onOpenDocument?.(filename)} disabled={!onOpenDocument}
                className="truncate text-left font-medium text-foreground hover:underline">{entry?.title ?? filename.replace(/\.scholarpen\.json$/, "")}</button>
              {outdated && <span className="ml-auto shrink-0 rounded bg-amber-500/10 px-1 text-[10px] text-amber-700">{entry ? "changed" : "not mapped"}</span>}
            </div>
            {entry?.summary && <p className="mt-1 text-muted-foreground">{entry.summary}</p>}
            {entry && (entry.claims.length + entry.terms.length + entry.numbers.length > 0) && (
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground">
                  {entry.claims.length} claims · {entry.terms.length} terms · {entry.numbers.length} numbers
                </summary>
                <ul className="mt-1 space-y-0.5 text-foreground">
                  {entry.claims.map((claim, index) => <li key={`c${index}`}>• {claim.text}</li>)}
                  {entry.terms.map((term, index) => <li key={`t${index}`}>• <span className="font-medium">{term.term}</span>: {term.definition}</li>)}
                  {entry.numbers.map((number, index) => <li key={`n${index}`}>• <span className="font-medium">{number.value}</span>: {number.context}</li>)}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConsistencySection({ check, onRun, onOpenDocument }: {
  check: ReturnType<typeof useProjectJob<ConsistencyView>>;
  onRun: () => void;
  onOpenDocument?: (filename: string) => void;
}) {
  const { view, error } = check;
  const grouped = useMemo(() => {
    const groups = new Map<string, NonNullable<ConsistencyView["report"]>["issues"]>();
    for (const issue of view?.report?.issues ?? []) groups.set(issue.filename, [...(groups.get(issue.filename) ?? []), issue]);
    return [...groups];
  }, [view]);
  if (!view) return error ? <p role="alert" className="text-[11px] text-red-600">{error}</p> : <p className="text-[11px] text-muted-foreground">Loading…</p>;
  const report = view.report;
  return (
    <div>
      <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
        Checks all documents together: references to missing figures or sections, repeated passages, glossary terms, and claims, definitions or numbers that contradict each other.
        Issues in open documents also become comments, so “Ask AI” can resolve them.
      </p>
      <button type="button" onClick={onRun} disabled={view.job.state === "running"}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40">
        <FileSearch className="h-3 w-3" /> Check the whole project
      </button>
      <JobLine job={view.job} />
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
      {report && (
        <div className="mt-2 text-[11px] leading-4">
          <p className="text-muted-foreground">
            {new Date(report.createdAt).toLocaleString()} · {report.documents} documents · {report.issues.length} issues · {report.posted} new comments
          </p>
          {report.skipped.map(item => <p key={item} className="text-amber-700">Not checked: {item}</p>)}
          {!report.issues.length && <p className="mt-1 text-emerald-700">No cross-document issues found.</p>}
          {grouped.map(([filename, issues]) => (
            <div key={filename} className="mt-2">
              <button type="button" onClick={() => onOpenDocument?.(filename)} disabled={!onOpenDocument}
                className="font-medium text-foreground hover:underline">{filename.replace(/\.scholarpen\.json$/, "")}</button>
              <ul className="mt-1 space-y-1">
                {issues.map(issue => (
                  <li key={issue.id} className="rounded border border-border p-1.5">
                    <span className="mr-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">{CONSISTENCY_KIND_LABEL[issue.kind]}</span>
                    <span className="text-foreground">{issue.comment}</span>
                    <p className="mt-0.5 truncate text-muted-foreground">“{issue.quote}”</p>
                    {issue.related && (
                      <p className="truncate text-muted-foreground">↔ {issue.related.filename.replace(/\.scholarpen\.json$/, "")}: “{issue.related.quote}”</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Project-wide writing tools: the glossary, the manuscript map and the consistency check. */
export function ProjectPanel({ projectPath, onOpenDocument }: { projectPath?: string; onOpenDocument?: (filename: string) => void }) {
  if (!projectPath) {
    return <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">Open a project to manage its glossary and chapters.</div>;
  }
  return <ProjectTools key={projectPath} projectPath={projectPath} onOpenDocument={onOpenDocument} />;
}

function ProjectTools({ projectPath, onOpenDocument }: { projectPath: string; onOpenDocument?: (filename: string) => void }) {
  const map = useProjectJob(projectPath, rpc.getManuscriptMap);
  const check = useProjectJob(projectPath, rpc.getConsistencyReport);
  const suggestions = (map.view?.documents ?? []).flatMap(document => document.entry?.terms ?? []);
  const start = <T extends { job: ProjectJobStatus }>(job: ReturnType<typeof useProjectJob<T>>, run: (projectPath: string) => Promise<T>) => () => {
    job.setError(null);
    run(projectPath).then(job.setView).catch(reason => job.setError(errorText(reason)));
  };
  const mapped = map.view?.documents.filter(document => document.entry).length ?? 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="Glossary" icon={<BookOpen className="h-3 w-3" />} summary="terms and abbreviations" defaultOpen>
        <GlossaryEditor projectPath={projectPath} suggestions={suggestions} />
      </Section>
      <Section title="Manuscript map" icon={<MapIcon className="h-3 w-3" />}
        summary={map.view ? `${mapped} of ${map.view.documents.length} documents mapped` : undefined}>
        <ManuscriptMapSection map={map} onUpdate={start(map, rpc.updateManuscriptMap)} onOpenDocument={onOpenDocument} />
      </Section>
      <Section title="Consistency across documents" icon={<FileSearch className="h-3 w-3" />}
        summary={check.view?.report ? `${check.view.report.issues.length} issues` : undefined}>
        <ConsistencySection check={check} onRun={start(check, rpc.runConsistencyCheck)} onOpenDocument={onOpenDocument} />
      </Section>
    </div>
  );
}
