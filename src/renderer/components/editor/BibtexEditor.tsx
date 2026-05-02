import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, FilePlus2, FilterX, List, RotateCcw, Save, SearchCheck, Trash2 } from "lucide-react";
import type { FileNode } from "../../../shared/rpc-types";
import {
  deduplicateBibtex,
  findDuplicateBibtexGroups,
  getBibtexIdentityKey,
  parseBibtexCitekeys,
  parseBibtexEntries,
  type BibtexEntry,
} from "../../../shared/bibtex-utils";
import { rpc } from "../../rpc";
import { TextFindPanel } from "./TextFindPanel";
import { useTextFind } from "../../hooks/useTextFind";

type BibtexView = "entries" | "review";
const TABLE_ROW_LIMIT = 500;
const REVIEW_ITEM_LIMIT = 200;

interface BibtexEditorProps {
  file: FileNode;
  initialContent: string;
  reloadTrigger?: number;
  onSaveReady?: (saveNow: (() => void) | null) => void;
  onSaved?: () => void;
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

function replaceEntryInBibtex(source: string, entry: BibtexEntry, nextRaw: string): string {
  const before = source.slice(0, entry.start).replace(/\s+$/g, "");
  const after = source.slice(entry.end).replace(/^\s+/g, "");
  return [before, nextRaw.trim(), after].filter(Boolean).join("\n\n");
}

function appendEntryToBibtex(source: string, rawEntry: string): string {
  return [source.trim(), rawEntry.trim()].filter(Boolean).join("\n\n");
}

function validateSingleEntry(raw: string): { entry?: BibtexEntry; error?: string } {
  const parsed = parseBibtexEntries(raw);
  if (parsed.issues.length > 0) return { error: parsed.issues[0].message };
  if (parsed.entries.length !== 1) return { error: "BibTeX entry를 하나만 입력하세요." };
  return { entry: parsed.entries[0] };
}

function findDuplicateForEntry(entries: BibtexEntry[], candidate: BibtexEntry, ignoreStart?: number): string | null {
  const candidateCitekey = candidate.citekey.toLowerCase();
  const candidateIdentity = getBibtexIdentityKey(candidate);
  for (const entry of entries) {
    if (ignoreStart !== undefined && entry.start === ignoreStart) continue;
    if (entry.citekey.toLowerCase() === candidateCitekey) return `citekey '${candidate.citekey}'가 이미 있습니다.`;
    if (candidateIdentity && getBibtexIdentityKey(entry) === candidateIdentity) {
      return `같은 DOI 또는 title/author/year로 보이는 entry가 이미 있습니다: ${entry.citekey}`;
    }
  }
  return null;
}

function parsedEntryByStart(entries: BibtexEntry[], start: number | null): BibtexEntry | null {
  if (start === null) return null;
  return entries.find((entry) => entry.start === start) ?? null;
}

export function BibtexEditor({ file, initialContent, reloadTrigger = 0, onSaveReady, onSaved }: BibtexEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<BibtexView>("entries");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [usedCitekeys, setUsedCitekeys] = useState<Set<string> | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [entryFilter, setEntryFilter] = useState("");
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [addDraft, setAddDraft] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const find = useTextFind(contentRef, file.path);
  const projectPath = file.path.substring(0, file.path.lastIndexOf("/"));
  const dirty = content !== savedContent;

  useEffect(() => {
    if (content !== savedContent) return;
    setContent(initialContent);
    setSavedContent(initialContent);
    setUsedCitekeys(null);
    setSelectedStart(null);
    setEditDraft("");
  }, [content, file.path, initialContent, reloadTrigger, savedContent]);

  const parsed = useMemo(() => parseBibtexEntries(content), [content]);
  const selectedEntry = useMemo(
    () => parsedEntryByStart(parsed.entries, selectedStart),
    [parsed.entries, selectedStart]
  );
  const editDirty = Boolean(selectedEntry && editDraft.trim() !== selectedEntry.raw.trim());
  const duplicateGroups = useMemo(() => findDuplicateBibtexGroups(parsed.entries), [parsed.entries]);
  const unusedEntries = useMemo(
    () => usedCitekeys ? parsed.entries.filter((entry) => !usedCitekeys.has(entry.citekey)) : [],
    [parsed.entries, usedCitekeys]
  );
  const filteredEntries = useMemo(() => {
    const query = entryFilter.trim().toLowerCase();
    if (!query) return parsed.entries;
    return parsed.entries.filter((entry) =>
      entry.citekey.toLowerCase().includes(query) ||
      (entry.fields.title ?? "").toLowerCase().includes(query)
    );
  }, [entryFilter, parsed.entries]);
  const visibleEntries = useMemo(() => filteredEntries.slice(0, TABLE_ROW_LIMIT), [filteredEntries]);
  const visibleUnusedEntries = useMemo(() => unusedEntries.slice(0, REVIEW_ITEM_LIMIT), [unusedEntries]);
  const visibleDuplicateGroups = useMemo(() => duplicateGroups.slice(0, REVIEW_ITEM_LIMIT), [duplicateGroups]);

  useEffect(() => {
    if (parsed.entries.length === 0) {
      setSelectedStart(null);
      setEditDraft("");
      return;
    }
    const existing = parsed.entries.find((entry) => entry.start === selectedStart);
    const next = existing ?? filteredEntries[0] ?? parsed.entries[0];
    if (!next || next.start === selectedStart) return;
    setSelectedStart(next.start);
    setEditDraft(next.raw);
  }, [filteredEntries, parsed.entries, selectedStart]);

  const flash = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 3500);
  }, []);

  const saveRaw = useCallback(async (next: string, text = "저장됨") => {
    await rpc.saveBibtexRaw(projectPath, next);
    setContent(next);
    setSavedContent(next);
    onSaved?.();
    flash(text);
  }, [flash, onSaved, projectPath]);

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

  const handleSelectEntry = useCallback((entry: BibtexEntry) => {
    if (editDirty && !window.confirm("저장하지 않은 entry 수정사항을 버리고 다른 entry를 열까요?")) return;
    setSelectedStart(entry.start);
    setEditDraft(entry.raw);
  }, [editDirty]);

  const handleSaveSelectedEntry = useCallback(async () => {
    if (!selectedEntry) return;
    const validation = validateSingleEntry(editDraft);
    if (validation.error || !validation.entry) {
      setSaveMsg(validation.error ?? "BibTeX entry를 확인하세요.");
      return;
    }
    const duplicate = findDuplicateForEntry(parsed.entries, validation.entry, selectedEntry.start);
    if (duplicate) {
      setSaveMsg(duplicate);
      return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      const next = replaceEntryInBibtex(content, selectedEntry, editDraft);
      await saveRaw(next, `'${validation.entry.citekey}' 저장됨`);
      const savedEntry = parseBibtexEntries(next).entries.find((entry) => entry.citekey === validation.entry?.citekey);
      setSelectedStart(savedEntry?.start ?? null);
      setEditDraft(savedEntry?.raw ?? "");
      setSaveMsg("저장됨");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [content, editDraft, parsed.entries, saveRaw, selectedEntry]);

  const handleAppendEntry = useCallback(async () => {
    const validation = validateSingleEntry(addDraft);
    if (validation.error || !validation.entry) {
      setSaveMsg(validation.error ?? "BibTeX entry를 확인하세요.");
      return;
    }
    const duplicate = findDuplicateForEntry(parsed.entries, validation.entry);
    if (duplicate) {
      setSaveMsg(duplicate);
      return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      const next = appendEntryToBibtex(content, addDraft);
      await saveRaw(next, `'${validation.entry.citekey}' 추가됨`);
      const savedEntry = parseBibtexEntries(next).entries.find((entry) => entry.citekey === validation.entry?.citekey);
      setSelectedStart(savedEntry?.start ?? null);
      setEditDraft(savedEntry?.raw ?? "");
      setAddDraft("");
      setSaveMsg("추가됨");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "추가 실패");
    } finally {
      setSaving(false);
    }
  }, [addDraft, content, parsed.entries, saveRaw]);

  useEffect(() => {
    if (!onSaveReady) return;
    onSaveReady(() => {
      if (editDirty) void handleSaveSelectedEntry();
      else void handleSave();
    });
    return () => onSaveReady(null);
  }, [editDirty, handleSave, handleSaveSelectedEntry, onSaveReady]);

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
    if (!entryFilter.trim() || filteredEntries.length === 0) return;
    if (!window.confirm(`현재 필터와 일치하는 ${filteredEntries.length}개 entry를 제거할까요?`)) return;
    await saveRaw(removeEntriesFromBibtex(content, filteredEntries), `${filteredEntries.length}개 filtered entry 제거됨`);
    setEntryFilter("");
  }, [entryFilter, content, filteredEntries, saveRaw]);

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
          {saveMsg && <span className={`text-xs ${saveMsg.includes("실패") || saveMsg.includes("이미") || saveMsg.includes("확인") || saveMsg.includes("입력") ? "text-red-400" : "text-emerald-500"}`}>{saveMsg}</span>}
          {editDirty && <span className="text-xs text-amber-500">entry 수정됨</span>}
          {dirty && !editDirty && <span className="text-xs text-amber-500">수정됨</span>}
          {message && <span className="text-xs text-emerald-500">{message}</span>}
          <button onClick={handleSaveSelectedEntry} disabled={saving || !selectedEntry || !editDirty} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40" title="선택한 BibTeX entry 저장">
            <Save className="h-3.5 w-3.5" />
            {saving ? "저장 중" : "Entry 저장"}
          </button>
          <button
            onClick={() => {
              if (!selectedEntry) return;
              setEditDraft(selectedEntry.raw);
              setSaveMsg("되돌림");
              setTimeout(() => setSaveMsg(null), 2000);
            }}
            disabled={!editDirty}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
            title="선택 entry를 마지막 저장본으로 되돌리기"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            되돌리기
          </button>
          <button onClick={handleDedup} disabled={editDirty} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40" title="citekey 중복 항목 제거">
            <FilterX className="h-3.5 w-3.5" />
            중복 제거
          </button>
          <button onClick={() => setView("entries")} className={`flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors ${view === "entries" ? "text-foreground bg-accent" : "text-muted-foreground hover:text-foreground"}`} title="BibTeX entry 목록">
            <List className="h-3.5 w-3.5" />
            Entries
          </button>
          <button onClick={() => setView("review")} className={`flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors ${view === "review" ? "text-foreground bg-accent" : "text-muted-foreground hover:text-foreground"}`} title="중복/미사용 항목 검토">
            <AlertTriangle className="h-3.5 w-3.5" />
            Review
          </button>
        </div>
      </div>

      <div ref={contentRef} className="flex-1 overflow-hidden">
        {view === "entries" && (
          <div className="flex h-full min-h-0 flex-col p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{parsed.entries.length} entries</span>
              {entryFilter.trim() && <span>{filteredEntries.length} matched</span>}
              <span>{duplicateGroups.length} duplicate groups</span>
              {usedCitekeys && <span>{unusedEntries.length} unused</span>}
              {parsed.issues.length > 0 && <span className="text-red-400">{parsed.issues.length} parse issues</span>}
              {filteredEntries.length > visibleEntries.length && <span>{visibleEntries.length} shown</span>}
              <div className="ml-auto flex min-w-[360px] items-center gap-2">
                <input
                  value={entryFilter}
                  onChange={(e) => setEntryFilter(e.target.value)}
                  placeholder="Filter citekey or title..."
                  className="h-8 flex-1 rounded border border-border bg-muted/40 px-2 text-xs text-foreground outline-none focus:border-primary"
                  aria-label="Filter BibTeX entries by citekey or title"
                />
                {entryFilter && (
                  <button
                    onClick={() => setEntryFilter("")}
                    className="h-8 px-2 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                    title="entry filter clear"
                  >
                    Clear
                  </button>
                )}
                <button
                  onClick={handleRemoveFilteredEntries}
                  disabled={!entryFilter.trim() || filteredEntries.length === 0}
                  className="flex h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="현재 필터 결과 제거"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  filtered 제거
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-md border border-border">
              <table className="w-full table-fixed text-xs">
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[72px]" />
                  <col />
                  <col className="w-[84px]" />
                  <col className="w-[56px]" />
                </colgroup>
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Citekey</th>
                    <th className="px-3 py-2 text-left font-medium">Year</th>
                    <th className="px-3 py-2 text-left font-medium">Title</th>
                    <th className="px-3 py-2 text-left font-medium" title="ok: 중복 아님, duplicate: 중복 후보, unused: 문서에서 아직 사용되지 않음">Status</th>
                    <th className="px-2 py-2 text-right font-medium">
                      <span className="inline-flex h-5 w-7 items-center justify-center" title="Remove entry">
                        <Trash2 className="h-3.5 w-3.5" />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEntries.length === 0 && (
                    <tr>
                      <td colSpan={5} className="border-t border-border/70 px-3 py-8 text-center text-muted-foreground">
                        필터와 일치하는 entry가 없습니다.
                      </td>
                    </tr>
                  )}
                  {visibleEntries.map((entry) => {
                    const isUnused = usedCitekeys ? !usedCitekeys.has(entry.citekey) : false;
                    const isDuplicate = duplicateGroups.some((group) => group.includes(entry));
                    const isSelected = selectedEntry?.start === entry.start;
                    return (
                      <tr
                        key={`${entry.citekey}-${entry.start}`}
                        onClick={() => handleSelectEntry(entry)}
                        className={`cursor-pointer border-t border-border/70 transition-colors ${isSelected ? "bg-primary/10" : "hover:bg-muted/40"}`}
                      >
                        <td className="truncate px-3 py-2 font-mono text-foreground">{entry.citekey}</td>
                        <td className="whitespace-nowrap px-3 py-2">{entry.fields.year ?? ""}</td>
                        <td className="truncate px-3 py-2">{entry.fields.title ?? ""}</td>
                        <td className="whitespace-nowrap px-3 py-2" title={isUnused ? "문서에서 아직 사용되지 않은 entry" : isDuplicate ? "citekey, DOI, 또는 title/author/year 기준 중복 후보" : "중복 후보가 아닌 entry"}>
                          <span className={isUnused ? "text-amber-500" : isDuplicate ? "text-red-400" : "text-emerald-500"}>
                            {isUnused ? "unused" : isDuplicate ? "duplicate" : "ok"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              handleRemoveEntry(entry);
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                            title={`${entry.citekey} 제거`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
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
            <div className="mt-4 grid h-[42%] min-h-[260px] grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
              <section className="flex min-h-0 flex-col rounded-md border border-border bg-muted/20">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {selectedEntry ? selectedEntry.citekey : "No entry selected"}
                    </div>
                    {selectedEntry && (
                      <div className="truncate text-xs text-muted-foreground">{selectedEntry.fields.title ?? "(untitled)"}</div>
                    )}
                  </div>
                  <button onClick={handleSaveSelectedEntry} disabled={saving || !selectedEntry || !editDirty} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40" title="선택 entry 저장">
                    <Save className="h-3.5 w-3.5" />
                    저장
                  </button>
                </div>
                <textarea
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  disabled={!selectedEntry}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 text-foreground outline-none disabled:opacity-50"
                  aria-label="Selected BibTeX entry editor"
                />
              </section>
              <section className="flex min-h-0 flex-col rounded-md border border-border bg-muted/20">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <FilePlus2 className="h-4 w-4 text-emerald-500" />
                  <div className="flex-1 text-sm font-medium text-foreground">Add new entry</div>
                  <button onClick={handleAppendEntry} disabled={saving || !addDraft.trim()} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40" title="새 BibTeX entry append">
                    <FilePlus2 className="h-3.5 w-3.5" />
                    Append
                  </button>
                </div>
                <textarea
                  value={addDraft}
                  onChange={(e) => setAddDraft(e.target.value)}
                  placeholder="@article{citekey,...}"
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 text-foreground outline-none placeholder:text-muted-foreground/50"
                  aria-label="New BibTeX entry editor"
                />
              </section>
            </div>
          </div>
        )}

        {view === "review" && (
          <div className="h-full overflow-y-auto p-4">
            <div className="mx-auto max-w-5xl space-y-4">
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
                      {unusedEntries.length - visibleUnusedEntries.length} more unused entries hidden from this review.
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
                      {duplicateGroups.length - visibleDuplicateGroups.length} more duplicate groups hidden from this review.
                    </div>
                  )}
                </div>
              )}
            </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
