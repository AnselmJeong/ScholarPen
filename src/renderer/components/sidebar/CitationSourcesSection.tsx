import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { onProjectUpdated, rpc } from "../../rpc";
import type { CitationSourcesStatus } from "../../../shared/rpc-types";

const POLL_MS = 2_000;

export function citationSourcesSummary(status: CitationSourcesStatus | null): string | undefined {
  if (!status) return undefined;
  if (status.indexing && status.progress?.total) return `indexing ${status.progress.done} of ${status.progress.total} PDFs`;
  return `${status.indexedCount} of ${status.pdfCount} PDFs indexed`;
}

/** Status of the background PDF index used by Check Citations, and the cited works it lacks. */
export function useCitationSources(projectPath: string) {
  const [status, setStatus] = useState<CitationSourcesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback((includeCoverage = false) => rpc.getCitationSourcesStatus(projectPath, includeCoverage)
    .then(next => {
      if (!next) return; // Browser-only development has no index.
      setStatus(current => ({ ...next, coverage: next.coverage ?? current?.coverage }));
      setError(null);
    })
    .catch(reason => setError(reason instanceof Error ? reason.message : String(reason))), [projectPath]);
  useEffect(() => { setStatus(null); void refresh(); }, [refresh]);
  useEffect(() => {
    if (!status?.indexing) return;
    const timer = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(timer);
  }, [status, refresh]);
  useEffect(() => onProjectUpdated((path, filePath) => {
    if (path === projectPath && /\/resources\/.+\.pdf$/i.test(filePath?.replace(/\\/g, "/") ?? "")) {
      // The Bun side debounces the scan; look again once it has started.
      setTimeout(() => void refresh(), 2_500);
    }
  }), [projectPath, refresh]);
  return { status, error, refresh, setError, setStatus };
}

export function CitationSourcesSection({ projectPath, sources }: {
  projectPath: string;
  sources: ReturnType<typeof useCitationSources>;
}) {
  const { status, error, refresh, setError, setStatus } = sources;
  const [checking, setChecking] = useState(false);
  const coverage = status?.coverage;
  const wasIndexing = React.useRef(false);
  const loadCoverage = useCallback(() => {
    setChecking(true);
    void refresh(true).finally(() => setChecking(false));
  }, [refresh]);
  useEffect(() => { loadCoverage(); }, [loadCoverage]);
  // Recount once a background scan finishes.
  useEffect(() => {
    if (wasIndexing.current && status && !status.indexing) loadCoverage();
    wasIndexing.current = Boolean(status?.indexing);
  }, [status, loadCoverage]);
  const rescan = () => {
    setError(null);
    rpc.rescanCitationSources(projectPath).then(next => next && setStatus(current => ({ ...next, coverage: current?.coverage })))
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        Check Citations reads the PDFs under <code>resources/</code>. They are indexed in the background whenever one is added or changed; cited works without a PDF are judged from their OpenAlex abstract, which is less certain.
      </p>
      {status && <p>
        {status.indexedCount} of {status.pdfCount} PDFs indexed
        {status.indexing && status.progress ? ` · indexing ${status.progress.done}/${status.progress.total}…` : ""}
      </p>}
      {coverage && <p>
        <span className="font-medium">{coverage.linkedCount} of {coverage.citedCount}</span> cited works have an indexed PDF
        {coverage.citedCount > 0 && ` (${Math.round(100 * coverage.linkedCount / coverage.citedCount)}%)`}.
      </p>}
      {coverage && coverage.missing.length > 0 && <details>
        <summary className="cursor-pointer text-muted-foreground">Cited works without a PDF ({coverage.missing.length})</summary>
        <ul className="mt-1 max-h-60 space-y-1 overflow-y-auto">
          {coverage.missing.map(item => <li key={item.citekey} className="break-words">
            <span className="font-mono">@{item.citekey}</span> {item.title}
            {item.doi && <> · <button type="button" className="text-primary underline" onClick={() => rpc.openExternal(`https://doi.org/${item.doi}`).catch(() => undefined)}>DOI</button></>}
          </li>)}
        </ul>
      </details>}
      {status && status.unreadable.length > 0 && <details>
        <summary className="cursor-pointer text-muted-foreground">PDFs without readable text ({status.noTextCount + status.failedCount})</summary>
        <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
          {status.unreadable.map(item => <li key={item.relpath} className="break-words">{item.relpath.replace(/^resources\//, "")} · {item.reason}</li>)}
        </ul>
      </details>}
      <div className="flex items-center gap-3">
        <button type="button" onClick={rescan} disabled={status?.indexing} className="flex items-center gap-1 text-primary disabled:opacity-50">
          <RefreshCw className="h-3 w-3" /> Rescan PDFs
        </button>
        <button type="button" onClick={loadCoverage} disabled={checking} className="text-primary disabled:opacity-50">
          {checking ? "Counting…" : "Recount cited works"}
        </button>
      </div>
      {(error || status?.lastError) && <p role="alert" className="break-words text-red-600">{error ?? status?.lastError}</p>}
    </div>
  );
}
