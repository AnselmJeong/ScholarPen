import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { PanelActions, PanelError, PanelNote } from "./panel-kit";
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
    <div className="space-y-2 text-xs leading-5">
      <PanelNote>
        Check Citations reads the PDFs under <code className="font-mono-ui">resources/</code>. They are indexed in the background whenever one is added or changed; cited works without a PDF are judged from their OpenAlex abstract, which is less certain.
      </PanelNote>
      {status && <p className="text-foreground">
        {status.indexedCount} of {status.pdfCount} PDFs indexed
        {status.indexing && status.progress ? ` · indexing ${status.progress.done}/${status.progress.total}…` : ""}
      </p>}
      {coverage && <p className="text-foreground">
        <span className="font-medium">{coverage.linkedCount} of {coverage.citedCount}</span> cited works have an indexed PDF
        {coverage.citedCount > 0 && ` (${Math.round(100 * coverage.linkedCount / coverage.citedCount)}%)`}.
      </p>}
      {coverage && coverage.missing.length > 0 && <details>
        <summary className="cursor-pointer text-muted-foreground">Cited works without a PDF ({coverage.missing.length})</summary>
        <ul className="mt-1 max-h-60 space-y-1 overflow-y-auto">
          {coverage.missing.map(item => <li key={item.citekey} className="break-words">
            <span className="font-mono-ui">@{item.citekey}</span> {item.title}
            {item.doi && <> · <Link isExternalLink onClick={() => void rpc.openExternal(`https://doi.org/${item.doi}`).catch(() => undefined)}>DOI</Link></>}
          </li>)}
        </ul>
      </details>}
      {status && status.unreadable.length > 0 && <details>
        <summary className="cursor-pointer text-muted-foreground">PDFs without readable text ({status.noTextCount + status.failedCount})</summary>
        <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
          {status.unreadable.map(item => <li key={item.relpath} className="break-words">{item.relpath.replace(/^resources\//, "")} · {item.reason}</li>)}
        </ul>
      </details>}
      <PanelActions>
        <Button label="Rescan PDFs" size="sm" variant="secondary" isDisabled={status?.indexing} isLoading={status?.indexing}
          icon={<RefreshCw className="h-3 w-3" aria-hidden />} onClick={rescan} />
        <Button label={checking ? "Counting…" : "Recount cited works"} size="sm" variant="ghost" isLoading={checking} onClick={loadCoverage} />
      </PanelActions>
      {(error || status?.lastError) && <PanelError>{error ?? status?.lastError}</PanelError>}
    </div>
  );
}
