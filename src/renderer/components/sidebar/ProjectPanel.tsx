import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BookCheck, BookOpen, FileSearch, Map as MapIcon, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { rpc } from "../../rpc";
import { PanelActions, PanelEmpty, PanelError, PanelNote, PanelSection } from "./panel-kit";
import { normalizeGlossary, type Glossary, type GlossaryEntry } from "../../../shared/glossary";
import type { ManuscriptMapView, ProjectJobStatus } from "../../../shared/manuscript-map";
import { CONSISTENCY_KIND_LABEL, type ConsistencyView } from "../../../shared/consistency-report";
import { ExtensionSlot } from "../../extensions/slots";
import { CitationSourcesSection, citationSourcesSummary, useCitationSources } from "./CitationSourcesSection";

const POLL_MS = 2_000;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function JobLine({ job }: { job: ProjectJobStatus }) {
  if (job.state === "running") return <PanelNote role="status" className="text-primary">{job.detail ?? "Working…"}</PanelNote>;
  if (job.state === "failed") return <PanelError>{job.error}</PanelError>;
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

  if (!saved) return error ? <PanelError>{error}</PanelError> : <PanelNote>Loading…</PanelNote>;
  return (
    <>
      <PanelNote>
        Shared terminology for every chapter. AI edits use these terms; reviews flag variants you explicitly avoid. Abbreviations introduced in another chapter need not be expanded again.
      </PanelNote>
      <ul className="space-y-2">
        {entries.map((entry, index) => (
          <li key={index} className="space-y-1.5 rounded-md border border-sidebar-border bg-background p-2">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <TextInput label="Preferred term" isLabelHidden size="sm" value={entry.term} placeholder="Preferred term"
                  onChange={value => patch(index, { term: value })} />
              </div>
              <div className="w-20">
                <TextInput label="Abbreviation" isLabelHidden size="sm" value={entry.abbreviation ?? ""} placeholder="Abbr."
                  onChange={value => patch(index, { abbreviation: value || undefined })} />
              </div>
              <Button label="Remove entry" tooltip="Remove entry" size="sm" variant="ghost" isIconOnly icon={<Trash2 className="h-3 w-3" aria-hidden />}
                onClick={() => setEntries(current => current.filter((_, at) => at !== index))} />
            </div>
            <TextInput label="Definition" isLabelHidden size="sm" value={entry.definition ?? ""} placeholder="Definition (optional)"
              onChange={value => patch(index, { definition: value || undefined })} />
            <TextInput label="Variants to avoid" isLabelHidden size="sm" value={(entry.avoid ?? []).join(", ")} placeholder="Avoid, comma-separated (optional)"
              onChange={value => patch(index, { avoid: value.split(",").map(part => part.trimStart()).filter((part, at, all) => part || at === all.length - 1) })} />
            {entry.abbreviation && (
              <CheckboxInput size="sm" label="well known, never spelled out" value={!!entry.noExpansion}
                onChange={checked => patch(index, { noExpansion: checked || undefined })} />
            )}
          </li>
        ))}
      </ul>
      <PanelActions>
        <Button label="Add term" size="sm" variant="secondary" icon={<Plus className="h-3 w-3" aria-hidden />}
          onClick={() => setEntries(current => [...current, emptyEntry()])} />
        <Button label="Save glossary" size="sm" variant="primary" isDisabled={!dirty} icon={<Save className="h-3 w-3" aria-hidden />}
          onClick={() => void save()} />
      </PanelActions>
      {status && !dirty && <PanelNote role="status">{status}</PanelNote>}
      {error && <PanelError>{error}</PanelError>}
      {missing.length > 0 && (
        <div className="space-y-1">
          <PanelNote>Terms the manuscript map found that the glossary does not have:</PanelNote>
          <ul className="flex flex-wrap gap-1">
            {missing.map(item => (
              <li key={item.term}>
                <Button size="sm" variant="ghost" tooltip={item.definition} icon={<Plus className="h-3 w-3" aria-hidden />} label={item.term}
                  onClick={() => setEntries(current => [...current, { term: item.term, definition: item.definition }])} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ManuscriptMapSection({ map, onUpdate, onOpenDocument }: {
  map: ReturnType<typeof useProjectJob<ManuscriptMapView>>;
  onUpdate: () => void;
  onOpenDocument?: (filename: string) => void;
}) {
  const { view, error } = map;
  if (!view) return error ? <PanelError>{error}</PanelError> : <PanelNote>Loading…</PanelNote>;
  const stale = view.documents.filter(document => document.stale).length;
  return (
    <>
      <PanelNote>
        A digest of every document (summary, key claims, definitions, numbers) that AI work on one chapter reads to stay consistent with the others.
      </PanelNote>
      <PanelActions>
        <Button size="sm" variant="secondary" isDisabled={view.job.state === "running" || !view.documents.length} isLoading={view.job.state === "running"}
          icon={<RefreshCw className="h-3 w-3" aria-hidden />} label={stale ? `Update map · ${stale} changed` : "Map is up to date"} onClick={onUpdate} />
      </PanelActions>
      <JobLine job={view.job} />
      {error && <PanelError>{error}</PanelError>}
      <ul className="space-y-2">
        {view.documents.map(({ filename, entry, stale: outdated }) => (
          <li key={filename} className="space-y-1 rounded-md border border-sidebar-border bg-background p-2 text-xs leading-5">
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => onOpenDocument?.(filename)} disabled={!onOpenDocument}
                className="truncate text-left font-medium text-foreground hover:underline">{entry?.title ?? filename.replace(/\.scholarpen\.json$/, "")}</button>
              {outdated && <span className="ml-auto shrink-0"><Badge variant="warning" label={entry ? "changed" : "not mapped"} /></span>}
            </div>
            {entry?.summary && <p className="text-muted-foreground">{entry.summary}</p>}
            {entry && (entry.claims.length + entry.terms.length + entry.numbers.length > 0) && (
              <details>
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
    </>
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
  if (!view) return error ? <PanelError>{error}</PanelError> : <PanelNote>Loading…</PanelNote>;
  const report = view.report;
  return (
    <>
      <PanelNote>
        Checks all documents together: references to missing figures or sections, repeated passages, glossary terms, and claims, definitions or numbers that contradict each other.
        Issues in open documents also become comments, so “Ask AI” can resolve them.
      </PanelNote>
      <PanelActions>
        <Button label="Check the whole project" size="sm" variant="secondary" isDisabled={view.job.state === "running"} isLoading={view.job.state === "running"}
          icon={<FileSearch className="h-3 w-3" aria-hidden />} onClick={onRun} />
      </PanelActions>
      <JobLine job={view.job} />
      {error && <PanelError>{error}</PanelError>}
      {report && (
        <div className="space-y-2 text-xs leading-5">
          <PanelNote>
            {new Date(report.createdAt).toLocaleString()} · {report.documents} documents · {report.issues.length} issues · {report.posted} new comments
          </PanelNote>
          {report.skipped.map(item => <p key={item} className="text-amber-700 dark:text-amber-400">Not checked: {item}</p>)}
          {!report.issues.length && <p className="text-emerald-700 dark:text-emerald-400">No cross-document issues found.</p>}
          {grouped.map(([filename, issues]) => (
            <div key={filename} className="space-y-1">
              <button type="button" onClick={() => onOpenDocument?.(filename)} disabled={!onOpenDocument}
                className="font-medium text-foreground hover:underline">{filename.replace(/\.scholarpen\.json$/, "")}</button>
              <ul className="space-y-1">
                {issues.map(issue => (
                  <li key={issue.id} className="space-y-0.5 rounded-md border border-sidebar-border bg-background p-2">
                    <div className="flex items-start gap-1.5">
                      <Badge label={CONSISTENCY_KIND_LABEL[issue.kind]} />
                      <span className="text-foreground">{issue.comment}</span>
                    </div>
                    <p className="truncate text-muted-foreground">“{issue.quote}”</p>
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
    </>
  );
}

/** Project-wide writing tools: the glossary, the manuscript map, the consistency check and cited-source PDFs. */
export function ProjectPanel({ projectPath, onOpenDocument }: { projectPath?: string; onOpenDocument?: (filename: string) => void }) {
  if (!projectPath) {
    return <PanelEmpty>Open a project to manage its glossary and chapters.</PanelEmpty>;
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
  const sources = useCitationSources(projectPath);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ExtensionSlot name="project" projectPath={projectPath} />
      <PanelSection title="Glossary" icon={BookOpen} summary="terms and abbreviations" defaultOpen>
        <GlossaryEditor projectPath={projectPath} suggestions={suggestions} />
      </PanelSection>
      <PanelSection title="Manuscript map" icon={MapIcon}
        summary={map.view ? `${mapped} of ${map.view.documents.length} documents mapped` : undefined}>
        <ManuscriptMapSection map={map} onUpdate={start(map, rpc.updateManuscriptMap)} onOpenDocument={onOpenDocument} />
      </PanelSection>
      <PanelSection title="Consistency across documents" icon={FileSearch}
        summary={check.view?.report ? `${check.view.report.issues.length} issues` : undefined}>
        <ConsistencySection check={check} onRun={start(check, rpc.runConsistencyCheck)} onOpenDocument={onOpenDocument} />
      </PanelSection>
      <PanelSection title="Cited sources" icon={BookCheck} summary={citationSourcesSummary(sources.status)}>
        <CitationSourcesSection projectPath={projectPath} sources={sources} />
      </PanelSection>
    </div>
  );
}
