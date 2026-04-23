import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Eye, FilterX, List, Pencil, RotateCcw, Save, SearchCheck, Trash2 } from "lucide-react";
import type { FileNode } from "../../../shared/rpc-types";
import {
  deduplicateBibtex,
  findDuplicateBibtexGroups,
  normalizeDoi,
  parseBibtexCitekeys,
  parseBibtexEntries,
  type BibtexEntry,
} from "../../../shared/bibtex-utils";
import { rpc } from "../../rpc";
import { TextFindPanel } from "./TextFindPanel";
import { useTextFind } from "../../hooks/useTextFind";

type BibtexView = "preview" | "entries" | "review" | "edit";
type TokenType = "entry" | "field" | "value" | "year" | "plain";
const PREVIEW_LINE_LIMIT = 2000;
const TABLE_ROW_LIMIT = 500;
const REVIEW_ITEM_LIMIT = 200;

interface Token {
  type: TokenType;
  text: string;
}

interface BibtexEditorProps {
  file: FileNode;
  initialContent: string;
  reloadTrigger?: number;
}

function tokenizeBibtexLine(line: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const entryMatch = line.match(/^(@\w+)\{/);
  if (entryMatch) {
    tokens.push({ type: "entry", text: entryMatch[1] });
    tokens.push({ type: "plain", text: "{" });
    pos = entryMatch[0].length;
  }

  while (pos < line.length) {
    const fieldMatch = line.slice(pos).match(/^(\w+)\s*=/);
    if (fieldMatch) {
      tokens.push({ type: "field", text: fieldMatch[1] });
      tokens.push({ type: "plain", text: line.slice(pos + fieldMatch[1].length, pos + fieldMatch[0].length) });
      pos += fieldMatch[0].length;
      continue;
    }
    const quoteMatch = line.slice(pos).match(/^("[^"]*")/);
    if (quoteMatch) {
      tokens.push({ type: "value", text: quoteMatch[1] });
      pos += quoteMatch[0].length;
      continue;
    }
    const yearMatch = line.slice(pos).match(/^(\d{4})/);
    if (yearMatch) {
      tokens.push({ type: "year", text: yearMatch[1] });
      pos += yearMatch[0].length;
      continue;
    }
    const lastPlain = tokens[tokens.length - 1];
    const ch = line[pos];
    if (lastPlain?.type === "plain") lastPlain.text += ch;
    else tokens.push({ type: "plain", text: ch });
    pos++;
  }
  return tokens;
}

const TOKEN_CLASS: Record<TokenType, string> = {
  entry: "text-purple-600 font-semibold",
  field: "text-blue-600",
  value: "text-green-700",
  year: "text-orange-600",
  plain: "",
};

function highlightBibtex(code: string): React.ReactNode[] {
  return code.split("\n").map((line, i) => {
    const tokens = tokenizeBibtexLine(line);
    return (
      <div key={i} className="flex">
        <span className="w-10 text-right pr-3 text-muted-foreground/50 select-none text-xs leading-5">{i + 1}</span>
        <span className="flex-1 text-xs leading-5 font-mono whitespace-pre">
          {tokens.map((t, j) =>
            TOKEN_CLASS[t.type] ? (
              <span key={j} className={TOKEN_CLASS[t.type]}>{t.text}</span>
            ) : (
              <span key={j}>{t.text}</span>
            )
          )}
        </span>
      </div>
    );
  });
}

function flattenDocumentFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.isDirectory && node.children) result.push(...flattenDocumentFiles(node.children));
    else if (node.kind === "document" && node.name.endsWith(".scholarpen.json")) result.push(node);
  }
  return result;
}

function collectCitationKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectCitationKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  const obj = value as Record<string, unknown>;
  const props = obj.props && typeof obj.props === "object" ? obj.props as Record<string, unknown> : null;
  if (obj.type === "citation") {
    const citekey = typeof props?.citekey === "string"
      ? props.citekey
      : typeof obj.citekey === "string"
        ? obj.citekey
        : "";
    if (citekey) keys.add(citekey);
  }
  for (const nested of Object.values(obj)) collectCitationKeys(nested, keys);
  return keys;
}

function entrySummary(entry: BibtexEntry): string {
  const author = entry.fields.author?.split(/\s+and\s+/i)[0] ?? "Unknown author";
  const year = entry.fields.year ?? "n.d.";
  const title = entry.fields.title ?? "(untitled)";
  return `${author} (${year}) ${title}`;
}

function removeEntriesFromBibtex(source: string, entriesToRemove: BibtexEntry[]): string {
  const ranges = [...entriesToRemove]
    .sort((a, b) => b.start - a.start)
    .map((entry) => ({ start: entry.start, end: entry.end }));
  let next = source;
  for (const { start, end } of ranges) {
    next = `${next.slice(0, start)}${next.slice(end)}`;
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

export function BibtexEditor({ file, initialContent, reloadTrigger = 0 }: BibtexEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<BibtexView>("preview");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [usedCitekeys, setUsedCitekeys] = useState<Set<string> | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [citekeyFilter, setCitekeyFilter] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const find = useTextFind(contentRef, file.path);
  const projectPath = file.path.substring(0, file.path.lastIndexOf("/"));
  const dirty = content !== savedContent;

  useEffect(() => {
    if (content !== savedContent) return;
    setContent(initialContent);
    setSavedContent(initialContent);
    setUsedCitekeys(null);
  }, [content, file.path, initialContent, reloadTrigger, savedContent]);

  const parsed = useMemo(() => parseBibtexEntries(content), [content]);
  const duplicateGroups = useMemo(() => findDuplicateBibtexGroups(parsed.entries), [parsed.entries]);
  const unusedEntries = useMemo(
    () => usedCitekeys ? parsed.entries.filter((entry) => !usedCitekeys.has(entry.citekey)) : [],
    [parsed.entries, usedCitekeys]
  );
  const preview = useMemo(() => {
    const lines = content.split("\n");
    return {
      content: lines.length > PREVIEW_LINE_LIMIT ? lines.slice(0, PREVIEW_LINE_LIMIT).join("\n") : content,
      truncated: lines.length > PREVIEW_LINE_LIMIT,
      totalLines: lines.length,
    };
  }, [content]);
  const filteredEntries = useMemo(() => {
    const query = citekeyFilter.trim().toLowerCase();
    if (!query) return parsed.entries;
    return parsed.entries.filter((entry) => entry.citekey.toLowerCase().includes(query));
  }, [citekeyFilter, parsed.entries]);
  const visibleEntries = useMemo(() => filteredEntries.slice(0, TABLE_ROW_LIMIT), [filteredEntries]);
  const visibleUnusedEntries = useMemo(() => unusedEntries.slice(0, REVIEW_ITEM_LIMIT), [unusedEntries]);
  const visibleDuplicateGroups = useMemo(() => duplicateGroups.slice(0, REVIEW_ITEM_LIMIT), [duplicateGroups]);

  const flash = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 3500);
  }, []);

  const saveRaw = useCallback(async (next: string, text = "저장됨") => {
    await rpc.saveBibtexRaw(projectPath, next);
    setContent(next);
    setSavedContent(next);
    flash(text);
  }, [flash, projectPath]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await saveRaw(content);
      setSaveMsg("저장됨");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [content, saveRaw]);

  const scanDocumentUsage = useCallback(async (): Promise<Set<string>> => {
    setUsageLoading(true);
    try {
      const tree = await rpc.listProjectFiles(projectPath);
      const docs = flattenDocumentFiles(tree);
      const keys = new Set<string>();
      await Promise.all(docs.map(async (doc) => {
        try {
          const data = await rpc.loadDocument(projectPath, doc.name);
          collectCitationKeys(data, keys);
        } catch (err) {
          console.warn("[BibTeX] Could not scan document citations:", doc.name, err);
        }
      }));
      setUsedCitekeys(keys);
      flash(`${docs.length}개 문서에서 ${keys.size}개 citekey 사용 확인`);
      return keys;
    } finally {
      setUsageLoading(false);
    }
  }, [flash, projectPath]);

  const handleDedup = useCallback(async () => {
    const before = parseBibtexCitekeys(content).length;
    const deduped = deduplicateBibtex(content);
    const after = parseBibtexCitekeys(deduped).length;
    await rpc.saveBibtex(projectPath, deduped);
    setContent(deduped);
    setSavedContent(deduped);
    flash(before - after > 0 ? `${before - after}개 citekey 중복 항목 제거됨` : "citekey 중복 없음");
  }, [content, flash, projectPath]);

  const handleRemoveUnused = useCallback(async () => {
    const keys = usedCitekeys ?? await scanDocumentUsage();
    const entriesToRemove = parsed.entries.filter((entry) => !keys.has(entry.citekey));
    const removed = entriesToRemove.length;
    if (removed === 0) {
      flash("미사용 항목 없음");
      return;
    }
    await saveRaw(removeEntriesFromBibtex(content, entriesToRemove), `${removed}개 미사용 항목 제거됨`);
  }, [content, flash, parsed.entries, saveRaw, scanDocumentUsage, usedCitekeys]);

  const handleRemoveDuplicateGroups = useCallback(async () => {
    const duplicateStarts = new Set<number>();
    for (const group of duplicateGroups) {
      for (const entry of group.slice(1)) duplicateStarts.add(entry.start);
    }
    if (duplicateStarts.size === 0) {
      flash("중복 후보 없음");
      return;
    }
    const entriesToRemove = parsed.entries.filter((entry) => duplicateStarts.has(entry.start));
    await saveRaw(removeEntriesFromBibtex(content, entriesToRemove), `${duplicateStarts.size}개 duplicate 후보 제거됨`);
  }, [content, duplicateGroups, flash, parsed.entries, saveRaw]);

  const handleRemoveEntry = useCallback(async (entry: BibtexEntry) => {
    if (!window.confirm(`'${entry.citekey}' entry를 references.bib에서 제거할까요?`)) return;
    await saveRaw(removeEntriesFromBibtex(content, [entry]), `'${entry.citekey}' 제거됨`);
  }, [content, saveRaw]);

  const handleRemoveFilteredEntries = useCallback(async () => {
    if (!citekeyFilter.trim() || filteredEntries.length === 0) return;
    if (!window.confirm(`현재 citekey 필터와 일치하는 ${filteredEntries.length}개 entry를 제거할까요?`)) return;
    await saveRaw(removeEntriesFromBibtex(content, filteredEntries), `${filteredEntries.length}개 filtered entry 제거됨`);
    setCitekeyFilter("");
  }, [citekeyFilter, content, filteredEntries, saveRaw]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background relative">
      {findOpen && (
        <TextFindPanel
          query={find.query}
          onQueryChange={find.setQuery}
          matchCount={find.matchCount}
          currentIdx={find.currentIdx}
          onNext={find.goNext}
          onPrev={find.goPrev}
          onClose={() => { setFindOpen(false); find.clear(); }}
        />
      )}
      <div className="px-6 py-2 border-b border-border text-sm text-muted-foreground font-medium flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-emerald-500" />
        <span>{file.name}</span>
        <span className="text-xs text-muted-foreground/60 ml-2">BibTeX</span>
        <div className="ml-auto flex items-center gap-2">
          {saveMsg && <span className={`text-xs ${saveMsg === "저장됨" ? "text-emerald-500" : "text-red-400"}`}>{saveMsg}</span>}
          {dirty && <span className="text-xs text-amber-500">수정됨</span>}
          {message && <span className="text-xs text-emerald-500">{message}</span>}
          {view === "edit" && (
            <>
              <button onClick={handleSave} disabled={saving || !dirty} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40" title="BibTeX 원문 저장">
                <Save className="h-3.5 w-3.5" />
                {saving ? "저장 중" : "저장"}
              </button>
              <button
                onClick={() => {
                  setContent(savedContent);
                  setSaveMsg("되돌림");
                  setTimeout(() => setSaveMsg(null), 2000);
                }}
                disabled={!dirty}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
                title="마지막 저장본으로 되돌리기"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                되돌리기
              </button>
            </>
          )}
          <button onClick={handleDedup} disabled={view === "edit" && dirty} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" title="citekey 중복 항목 제거">
            <FilterX className="h-3.5 w-3.5" />
            중복 제거
          </button>
          <button onClick={() => setView((v) => v === "entries" ? "preview" : "entries")} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" title="BibTeX entry 목록">
            <List className="h-3.5 w-3.5" />
            Entries
          </button>
          <button onClick={() => setView((v) => v === "review" ? "preview" : "review")} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" title="중복/미사용 항목 검토">
            <AlertTriangle className="h-3.5 w-3.5" />
            Review
          </button>
          <button onClick={() => setView((v) => v === "edit" ? "preview" : "edit")} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" title={view === "edit" ? "미리보기" : "BibTeX 직접 편집"}>
            {view === "edit" ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {view === "edit" ? "미리보기" : "편집"}
          </button>
        </div>
      </div>

      <div ref={contentRef} className="flex-1 overflow-y-auto">
        {view === "edit" && (
          <div className="h-full p-4">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} className="h-full w-full resize-none rounded-md border border-border bg-muted/40 p-4 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary" aria-label="BibTeX editor" />
          </div>
        )}

        {view === "entries" && (
          <div className="max-w-6xl mx-auto p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{parsed.entries.length} entries</span>
              {citekeyFilter.trim() && <span>{filteredEntries.length} matched</span>}
              <span>{duplicateGroups.length} duplicate groups</span>
              {usedCitekeys && <span>{unusedEntries.length} unused</span>}
              {parsed.issues.length > 0 && <span className="text-red-400">{parsed.issues.length} parse issues</span>}
              {filteredEntries.length > visibleEntries.length && <span>{visibleEntries.length} shown</span>}
              <div className="ml-auto flex min-w-[260px] items-center gap-2">
                <input
                  value={citekeyFilter}
                  onChange={(e) => setCitekeyFilter(e.target.value)}
                  placeholder="Filter citekey..."
                  className="h-8 flex-1 rounded border border-border bg-muted/40 px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                  aria-label="Filter BibTeX entries by citekey"
                />
                {citekeyFilter && (
                  <button
                    onClick={() => setCitekeyFilter("")}
                    className="h-8 px-2 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                    title="citekey filter clear"
                  >
                    Clear
                  </button>
                )}
                <button
                  onClick={handleRemoveFilteredEntries}
                  disabled={!citekeyFilter.trim() || filteredEntries.length === 0}
                  className="flex h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="현재 citekey 필터 결과 제거"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  filtered 제거
                </button>
              </div>
            </div>
            <div className="overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Citekey</th>
                    <th className="px-3 py-2 text-left font-medium">Year</th>
                    <th className="px-3 py-2 text-left font-medium">Title</th>
                    <th className="px-3 py-2 text-left font-medium">DOI</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEntries.length === 0 && (
                    <tr>
                      <td colSpan={6} className="border-t border-border/70 px-3 py-8 text-center text-muted-foreground">
                        citekey filter와 일치하는 entry가 없습니다.
                      </td>
                    </tr>
                  )}
                  {visibleEntries.map((entry) => {
                    const isUnused = usedCitekeys ? !usedCitekeys.has(entry.citekey) : false;
                    const isDuplicate = duplicateGroups.some((group) => group.includes(entry));
                    return (
                      <tr key={`${entry.citekey}-${entry.start}`} className="border-t border-border/70">
                        <td className="px-3 py-2 font-mono text-foreground">{entry.citekey}</td>
                        <td className="px-3 py-2">{entry.fields.year ?? ""}</td>
                        <td className="px-3 py-2 max-w-md truncate">{entry.fields.title ?? ""}</td>
                        <td className="px-3 py-2 font-mono max-w-xs truncate">{normalizeDoi(entry.fields.doi)}</td>
                        <td className="px-3 py-2">
                          <span className={isUnused ? "text-amber-500" : isDuplicate ? "text-red-400" : "text-emerald-500"}>
                            {isUnused ? "unused" : isDuplicate ? "duplicate" : "ok"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => handleRemoveEntry(entry)}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                            title={`${entry.citekey} 제거`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            제거
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredEntries.length > visibleEntries.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing first {visibleEntries.length} matching entries. Review cleanup still applies to the full file.
              </p>
            )}
          </div>
        )}

        {view === "review" && (
          <div className="max-w-5xl mx-auto p-4 space-y-4">
            {parsed.issues.length > 0 && (
              <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                <div className="font-semibold mb-1">Parse issues</div>
                {parsed.issues.map((issue, idx) => <div key={idx} className="text-xs">offset {issue.offset}: {issue.message}</div>)}
              </div>
            )}
            <section className="rounded-md border border-border p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Unused entries</h3>
                  <p className="text-xs text-muted-foreground">All `.scholarpen.json` documents are scanned for inline citation citekeys.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={scanDocumentUsage} disabled={usageLoading} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40">
                    <SearchCheck className="h-3.5 w-3.5" />
                    {usageLoading ? "스캔 중" : "사용 스캔"}
                  </button>
                  <button onClick={handleRemoveUnused} disabled={usageLoading || !usedCitekeys || unusedEntries.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40">
                    <Trash2 className="h-3.5 w-3.5" />
                    미사용 제거
                  </button>
                </div>
              </div>
              {!usedCitekeys ? <p className="text-xs text-muted-foreground">아직 문서 사용량을 스캔하지 않았습니다.</p> : unusedEntries.length === 0 ? <p className="text-xs text-emerald-500">미사용 BibTeX entry가 없습니다.</p> : (
                <div className="max-h-56 overflow-auto space-y-1">
                  {visibleUnusedEntries.map((entry) => (
                    <div key={`${entry.citekey}-${entry.start}`} className="rounded border border-border/70 px-2 py-1.5 text-xs">
                      <span className="font-mono text-amber-500">{entry.citekey}</span>
                      <span className="ml-2 text-muted-foreground">{entrySummary(entry)}</span>
                    </div>
                  ))}
                  {unusedEntries.length > visibleUnusedEntries.length && (
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                      {unusedEntries.length - visibleUnusedEntries.length} more unused entries hidden from this preview.
                    </div>
                  )}
                </div>
              )}
            </section>
            <section className="rounded-md border border-border p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Duplicate review</h3>
                  <p className="text-xs text-muted-foreground">Exact citekey duplicates plus DOI/title-author-year identity duplicates are grouped.</p>
                </div>
                <button onClick={handleRemoveDuplicateGroups} disabled={duplicateGroups.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40">
                  <FilterX className="h-3.5 w-3.5" />
                  후보 제거
                </button>
              </div>
              {duplicateGroups.length === 0 ? <p className="text-xs text-emerald-500">중복 후보가 없습니다.</p> : (
                <div className="space-y-3">
                  {visibleDuplicateGroups.map((group, idx) => (
                    <div key={idx} className="rounded border border-border/70 p-2">
                      <div className="mb-1 text-xs font-semibold text-foreground">Group {idx + 1}</div>
                      {group.map((entry, entryIdx) => (
                        <div key={`${entry.citekey}-${entry.start}`} className="text-xs">
                          <span className={entryIdx === 0 ? "font-mono text-emerald-500" : "font-mono text-red-400"}>
                            {entryIdx === 0 ? "keep " : "drop "}
                            {entry.citekey}
                          </span>
                          <span className="ml-2 text-muted-foreground">{entrySummary(entry)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {duplicateGroups.length > visibleDuplicateGroups.length && (
                    <div className="text-xs text-muted-foreground">
                      {duplicateGroups.length - visibleDuplicateGroups.length} more duplicate groups hidden from this preview.
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {view === "preview" && (
          <div className="max-w-4xl mx-auto px-4 py-4 bg-muted/50 border border-border rounded-lg m-4">
            {preview.truncated && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                Preview is limited to the first {PREVIEW_LINE_LIMIT} of {preview.totalLines} lines. Edit mode still contains the full file.
              </div>
            )}
            <div className="overflow-x-auto">{highlightBibtex(preview.content)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
