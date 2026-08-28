import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, FilePlus2, FilterX, List, RotateCcw, Save, SearchCheck, ShieldCheck, Trash2, Upload, WandSparkles, Wrench } from "lucide-react";
import type {
  BibliographyMaintenanceResult,
  BibliographyRepairProposal,
  BibliographyValidationProgress,
  FileNode,
} from "../../../shared/rpc-types";
import {
  areBibtexEntriesDuplicates,
  buildBibtexAppendPlan,
  findDuplicateBibtexGroups,
  parseBibtexEntries,
  partitionBibtexAdditions,
  type BibtexEntry,
  type BibtexParseIssue,
} from "../../../shared/bibtex-utils";
import { onBibliographyValidationProgress, rpc } from "../../rpc";
import { TextFindPanel } from "./TextFindPanel";
import { useTextFind } from "../../hooks/useTextFind";
import { BibliographyValidationReview } from "./BibliographyValidationReview";
import { decideExternalBibtexSync } from "./bibtex-external-sync";

type BibtexView = "entries" | "review";
const TABLE_ROW_LIMIT = 500;
const REVIEW_ITEM_LIMIT = 200;

interface BibtexEditorProps {
  file: FileNode;
  projectPath: string;
  initialContent: string;
  reloadTrigger?: number;
  onSaveReady?: (saveNow: (() => void) | null) => void;
  onSaved?: () => void;
  onBeforeBibliographyMaintenance?: () => Promise<void>;
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

function validateSingleEntry(raw: string): { entry?: BibtexEntry; error?: string } {
  const parsed = parseBibtexEntries(raw);
  if (parsed.issues.length > 0) return { error: parsed.issues[0].message };
  if (parsed.entries.length !== 1) return { error: "BibTeX entry를 하나만 입력하세요." };
  return { entry: parsed.entries[0] };
}

function findDuplicateForEntry(entries: BibtexEntry[], candidate: BibtexEntry, ignoreStart?: number): string | null {
  for (const entry of entries) {
    if (ignoreStart !== undefined && entry.start === ignoreStart) continue;
    if (!areBibtexEntriesDuplicates(entry, candidate)) continue;
    if (entry.citekey.toLocaleLowerCase() === candidate.citekey.toLocaleLowerCase()) {
      return `citekey '${candidate.citekey}'가 이미 있습니다.`;
    }
    return `같은 DOI 또는 title/author/year로 보이는 entry가 이미 있습니다: ${entry.citekey}`;
  }
  return null;
}

function parsedEntryByStart(entries: BibtexEntry[], start: number | null): BibtexEntry | null {
  if (start === null) return null;
  return entries.find((entry) => entry.start === start) ?? null;
}

function parseIssueLabel(code: string): string {
  if (code === "unclosed_entry") return "닫히지 않은 entry";
  if (code === "invalid_header") return "잘못된 entry header";
  if (code === "missing_citekey") return "citekey 뒤 comma 누락";
  if (code === "empty_citekey") return "빈 citekey";
  return "BibTeX syntax issue";
}

export function BibtexEditor({
  file,
  projectPath,
  initialContent,
  reloadTrigger = 0,
  onSaveReady,
  onSaved,
  onBeforeBibliographyMaintenance,
}: BibtexEditorProps) {
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
  const [validationResult, setValidationResult] = useState<BibliographyMaintenanceResult | null>(null);
  const [validationProgress, setValidationProgress] = useState<BibliographyValidationProgress | null>(null);
  const [repairProposal, setRepairProposal] = useState<BibliographyRepairProposal | null>(null);
  const [repairDraft, setRepairDraft] = useState(initialContent);
  const [repairing, setRepairing] = useState<"deterministic" | "llm" | null>(null);
  const [externalContent, setExternalContent] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const repairEditorRef = useRef<HTMLTextAreaElement>(null);
  const bibtexImportRef = useRef<HTMLInputElement>(null);
  const find = useTextFind(contentRef, file.path);
  const dirty = content !== savedContent;

  useEffect(() => onBibliographyValidationProgress(setValidationProgress), []);

  useEffect(() => setValidationResult(null), [file.path, projectPath]);

  const parsed = useMemo(() => parseBibtexEntries(content), [content]);
  const repairDraftParsed = useMemo(() => parseBibtexEntries(repairDraft), [repairDraft]);
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
    const decision = decideExternalBibtexSync(
      savedContent,
      initialContent,
      dirty || editDirty,
    );
    if (decision === "unchanged") return;
    if (decision === "conflict") {
      setExternalContent(initialContent);
      return;
    }

    setExternalContent(null);
    setContent(initialContent);
    setSavedContent(initialContent);
    setUsedCitekeys(null);
    setSelectedStart(null);
    setEditDraft("");
    setValidationResult(null);
  }, [dirty, editDirty, file.path, initialContent, reloadTrigger, savedContent]);

  useEffect(() => {
    setRepairDraft(content);
    setRepairProposal(null);
  }, [content, file.path]);

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
    await rpc.saveBibtexValidated(projectPath, next, savedContent);
    setExternalContent(null);
    setContent(next);
    setSavedContent(next);
    onSaved?.();
    flash(text);
  }, [flash, onSaved, projectPath, savedContent]);

  const handleReloadExternal = useCallback(async () => {
    if (externalContent === null) return;
    const confirmed = await rpc.confirmAction({
      title: "Reload external bibliography",
      message: "Discard the unsaved entry edit and load the externally changed references.bib?",
      detail: "ScholarPen will not write the older in-memory copy back to disk.",
      confirmLabel: "Load external file",
    });
    if (!confirmed) return;
    setContent(externalContent);
    setSavedContent(externalContent);
    setExternalContent(null);
    setSelectedStart(null);
    setEditDraft("");
    setUsedCitekeys(null);
    setValidationResult(null);
    flash("Externally changed references.bib loaded");
  }, [externalContent, flash]);

  const handleMergeBibtexFile = useCallback(async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";
    if (!selectedFile) return;
    if (dirty || editDirty || externalContent !== null) {
      setSaveMsg("Save or reload the current bibliography before importing another .bib file.");
      return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      const importedBibtex = await selectedFile.text();
      const result = await rpc.mergeBibtex(projectPath, importedBibtex);
      setContent(result.bibtex);
      setSavedContent(result.bibtex);
      setExternalContent(null);
      setSelectedStart(null);
      setEditDraft("");
      setUsedCitekeys(null);
      setValidationResult(null);
      onSaved?.();

      const skipped = result.skippedDuplicates.length;
      const examples = result.skippedDuplicates.slice(0, 3).map((entry) => (
        `${entry.citekey} → ${entry.duplicateOfCitekey}`
      )).join(", ");
      const summary = result.addedEntries > 0
        ? `${selectedFile.name}: ${result.addedEntries} added · ${skipped} duplicates skipped`
        : `${selectedFile.name}: all ${skipped} entries were duplicates; no changes written`;
      flash(`${summary}${examples ? ` (${examples})` : ""}`);
    } catch (error) {
      setSaveMsg(error instanceof Error ? error.message : "BibTeX file import failed");
    } finally {
      setSaving(false);
    }
  }, [dirty, editDirty, externalContent, flash, onSaved, projectPath]);

  const handleSave = useCallback(async () => {
    if (parsed.issues.length > 0) {
      setView("review");
      const issue = parsed.issues[0];
      setSaveMsg(`line ${issue.line}, column ${issue.column}: ${issue.message}`);
      return;
    }
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
  }, [content, parsed.issues, saveRaw]);

  const handleSelectEntry = useCallback(async (entry: BibtexEntry) => {
    if (editDirty) {
      const confirmed = await rpc.confirmAction({
        title: "저장하지 않은 변경사항",
        message: "저장하지 않은 entry 수정사항을 버리고 다른 entry를 열까요?",
        confirmLabel: "변경사항 버리기",
      });
      if (!confirmed) return;
    }
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
    if (parsed.issues.length > 0) {
      setView("review");
      const issue = parsed.issues[0];
      setSaveMsg(
        `기존 bibliography가 line ${issue.line}, column ${issue.column}에서 유효하지 않아 append하지 않았습니다.`,
      );
      return;
    }
    let appendPlan;
    try {
      appendPlan = buildBibtexAppendPlan(content, addDraft);
    } catch (error) {
      setSaveMsg(error instanceof Error ? error.message : "BibTeX entry를 확인하세요.");
      return;
    }
    const { accepted: pendingEntries, skipped } = partitionBibtexAdditions(
      parsed.entries,
      appendPlan.addedEntries,
    );
    if (pendingEntries.length === 0) {
      const examples = skipped.slice(0, 3).map(({ entry, duplicateOf }) => (
        `${entry.citekey} → ${duplicateOf.citekey}`
      )).join(", ");
      setAddDraft("");
      setSaveMsg(`${skipped.length}개 중복을 건너뜀 · 추가할 새 entry 없음${examples ? ` (${examples})` : ""}`);
      return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      const uniquePlan = buildBibtexAppendPlan(
        content,
        pendingEntries.map((entry) => entry.raw).join("\n\n"),
      );
      const next = uniquePlan.bibtex;
      const count = pendingEntries.length;
      const skippedExamples = skipped.slice(0, 3).map(({ entry, duplicateOf }) => (
        `${entry.citekey} → ${duplicateOf.citekey}`
      )).join(", ");
      const resultMessage = skipped.length > 0
        ? `${count}개 추가 · ${skipped.length}개 중복 건너뜀${skippedExamples ? ` (${skippedExamples})` : ""}`
        : count === 1
          ? `'${pendingEntries[0].citekey}' 추가됨`
          : `${count}개 BibTeX entries 추가됨`;
      await saveRaw(next, resultMessage);
      const lastCitekey = pendingEntries.at(-1)?.citekey;
      const savedEntry = parseBibtexEntries(next).entries.find((entry) => entry.citekey === lastCitekey);
      setSelectedStart(savedEntry?.start ?? null);
      setEditDraft(savedEntry?.raw ?? "");
      setAddDraft("");
      setSaveMsg(skipped.length > 0 ? resultMessage : count === 1 ? "추가됨" : `${count}개 추가됨`);
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "추가 실패");
    } finally {
      setSaving(false);
    }
  }, [addDraft, content, parsed.entries, parsed.issues, saveRaw]);

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

  const performDedup = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await onBeforeBibliographyMaintenance?.();
      const result = await rpc.deduplicateBibliography(projectPath, content);
      setContent(result.bibtex);
      setSavedContent(result.bibtex);
      setUsedCitekeys(null);
      setSelectedStart(null);
      setEditDraft("");
      onSaved?.();
      flash(
        `${result.removedEntries}개 중복 제거 · `
        + `${result.updatedDocuments}개 document에서 ${result.remappedCitations}개 인용 통일`
      );
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "중복 제거 실패");
    } finally {
      setSaving(false);
    }
  }, [
    content,
    flash,
    onBeforeBibliographyMaintenance,
    onSaved,
    projectPath,
  ]);

  const handleDedup = useCallback(async () => {
    const duplicateCount = duplicateGroups.reduce((count, group) => count + group.length - 1, 0);
    if (duplicateCount === 0) {
      flash("citekey, DOI, title/author/year 기준 중복 없음");
      return;
    }
    const confirmed = await rpc.confirmAction({
      title: "중복 references 정리",
      message: `${duplicateCount}개 중복 entry를 제거할까요?`,
      detail: "Documents의 인용 citekey는 유지할 entry로 통일됩니다. 변경 전 bibliography와 관련 documents는 자동으로 백업됩니다.",
      confirmLabel: "중복 제거",
    });
    if (!confirmed) return;

    await performDedup();
  }, [duplicateGroups, flash, performDedup]);

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

  const handleRemoveEntry = useCallback(async (entry: BibtexEntry) => {
    const duplicateGroup = duplicateGroups.find((group) => group.includes(entry));
    if (duplicateGroup) {
      const duplicateCount = duplicateGroups.reduce(
        (count, group) => count + group.length - 1,
        0,
      );
      const confirmed = await rpc.confirmAction({
        title: "중복 reference 정리",
        message: `'${entry.citekey}'는 중복 그룹에 속합니다. ${duplicateCount}개 중복 entry를 정리할까요?`,
        detail: "각 그룹의 첫 entry를 유지하고 나머지를 제거합니다. Documents의 citation은 유지한 citekey로 통일되며, 변경 전 파일은 자동으로 백업됩니다.",
        confirmLabel: "중복 정리",
      });
      if (confirmed) await performDedup();
      return;
    }

    const confirmed = await rpc.confirmAction({
      title: "Reference 제거",
      message: `'${entry.citekey}' entry를 references.bib에서 제거할까요?`,
      detail: "이 작업은 bibliography에서 해당 entry만 제거합니다.",
      confirmLabel: "제거",
    });
    if (!confirmed) return;

    setSaving(true);
    setSaveMsg(null);
    try {
      await saveRaw(removeEntriesFromBibtex(content, [entry]), `'${entry.citekey}' 제거됨`);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "제거 실패");
    } finally {
      setSaving(false);
    }
  }, [content, duplicateGroups, performDedup, saveRaw]);

  const handleRemoveFilteredEntries = useCallback(async () => {
    if (!entryFilter.trim() || filteredEntries.length === 0) return;
    const confirmed = await rpc.confirmAction({
      title: "Filtered references 제거",
      message: `현재 필터와 일치하는 ${filteredEntries.length}개 entry를 제거할까요?`,
      detail: "이 작업은 bibliography에서 현재 필터 결과를 모두 제거합니다.",
      confirmLabel: "모두 제거",
    });
    if (!confirmed) return;

    setSaving(true);
    setSaveMsg(null);
    try {
      await saveRaw(
        removeEntriesFromBibtex(content, filteredEntries),
        `${filteredEntries.length}개 filtered entry 제거됨`,
      );
      setEntryFilter("");
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "제거 실패");
    } finally {
      setSaving(false);
    }
  }, [entryFilter, content, filteredEntries, saveRaw]);

  const handleValidateAndClean = useCallback(async () => {
    if (parsed.issues.length > 0) {
      setView("review");
      setSaveMsg("BibTeX parse issue를 먼저 수정하세요.");
      return;
    }
    const confirmed = await rpc.confirmAction({
      title: "인용 정리 · 서지정보 검증",
      message: "모든 문서의 인용을 스캔해 미사용 BibTeX entry를 제거하고, 인용된 entry를 Crossref로 검증할까요?",
      detail: "삭제 전 references.bib를 자동 백업합니다. DOI가 없는 entry는 제목·저자·연도가 강하게 일치할 때만 DOI를 제안합니다. 저자 등 민감한 차이는 자동 변경하지 않으며 결과에서 검토할 수 있습니다.",
      confirmLabel: "정리 · 검증",
    });
    if (!confirmed) return;

    setSaving(true);
    setSaveMsg(null);
    setValidationResult(null);
    setView("review");
    try {
      await onBeforeBibliographyMaintenance?.();
      const result = await rpc.validateAndCleanBibliography(projectPath, content);
      setContent(result.bibtex);
      setSavedContent(result.bibtex);
      setUsedCitekeys(null);
      setSelectedStart(null);
      setEditDraft("");
      setValidationResult(result);
      onSaved?.();
      flash(`미사용 ${result.removedUnused}개 제거 · 인용된 ${result.usedEntries}개 검증 완료`);
    } catch (error) {
      setSaveMsg(error instanceof Error ? error.message : "서지정보 검증 실패");
    } finally {
      setSaving(false);
      setValidationProgress(null);
    }
  }, [
    content,
    flash,
    onBeforeBibliographyMaintenance,
    onSaved,
    parsed.issues.length,
    projectPath,
  ]);

  const handleApplyValidation = useCallback(async () => {
    if (!validationResult || validationResult.suggestedBibtex === validationResult.bibtex) return;
    const suggestedCount = validationResult.validations.filter((item) => item.suggestedFields).length;
    const confirmed = await rpc.confirmAction({
      title: "확인된 서지정보 보정 반영",
      message: `${suggestedCount}개 entry의 확인된 보정을 references.bib에 반영할까요?`,
      detail: "DOI, 권·호·페이지와 NLM에서 확인된 저널 표준 약어만 자동 반영합니다. 제목·저자 불일치 항목은 변경하지 않습니다.",
      confirmLabel: "보정 반영",
    });
    if (!confirmed) return;

    setSaving(true);
    setSaveMsg(null);
    try {
      await rpc.applyBibliographyValidation(
        projectPath,
        validationResult.suggestedBibtex,
        validationResult.bibtex,
      );
      setContent(validationResult.suggestedBibtex);
      setSavedContent(validationResult.suggestedBibtex);
      onSaved?.();
      flash(`${suggestedCount}개 entry 보정 반영됨`);
      setValidationResult({
        ...validationResult,
        bibtex: validationResult.suggestedBibtex,
      });
    } catch (error) {
      setSaveMsg(error instanceof Error ? error.message : "보정 반영 실패");
    } finally {
      setSaving(false);
    }
  }, [flash, onSaved, projectPath, validationResult]);

  const handleProposeRepair = useCallback(async (mode: "deterministic" | "llm") => {
    setRepairing(mode);
    setSaveMsg(null);
    try {
      const proposal = await rpc.proposeBibliographyRepair(projectPath, content, mode);
      setRepairProposal(proposal);
      setRepairDraft(proposal.repairedBibtex);
      flash(
        proposal.method === "llm"
          ? `${proposal.model ?? "LLM"} syntax repair proposal ready`
          : "Safe syntax repair proposal ready",
      );
    } catch (error) {
      setSaveMsg(error instanceof Error ? error.message : "Bibliography repair proposal failed");
    } finally {
      setRepairing(null);
    }
  }, [content, flash, projectPath]);

  const focusRepairIssue = useCallback((issue: BibtexParseIssue) => {
    const editor = repairEditorRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(
      Math.min(issue.offset, repairDraft.length),
      Math.min(issue.offset + Math.max(1, issue.entryHint?.length ?? 1), repairDraft.length),
    );
    editor.scrollTop = Math.max(0, (issue.line - 3) * 20);
  }, [repairDraft.length]);

  const handleApplyRepair = useCallback(async () => {
    if (repairDraft === content) return;
    if (repairDraftParsed.issues.length > 0) {
      const issue = repairDraftParsed.issues[0];
      setSaveMsg(`Repair draft is invalid at line ${issue.line}, column ${issue.column}: ${issue.message}`);
      return;
    }
    const confirmed = await rpc.confirmAction({
      title: "Apply bibliography syntax repair",
      message: "Apply the validated repair to references.bib?",
      detail: "The current bibliography is backed up first. The repair is rejected if entries or parsed metadata changed, or if references.bib changed after this proposal was created.",
      confirmLabel: "Apply repair",
    });
    if (!confirmed) return;

    setSaving(true);
    setSaveMsg(null);
    try {
      const backupPath = await rpc.applyBibliographyRepair(projectPath, content, repairDraft);
      setContent(repairDraft);
      setSavedContent(repairDraft);
      setSelectedStart(null);
      setEditDraft("");
      setRepairProposal(null);
      onSaved?.();
      flash(backupPath ? "Syntax repaired · original bibliography backed up" : "Syntax repaired");
    } catch (error) {
      setSaveMsg(error instanceof Error ? error.message : "Bibliography repair failed");
    } finally {
      setSaving(false);
    }
  }, [content, flash, onSaved, projectPath, repairDraft, repairDraftParsed.issues]);

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
          {saveMsg && <span className={`text-xs ${/(실패|이미|확인|입력|유효하지|invalid|error|line \d+)/i.test(saveMsg) ? "text-red-400" : "text-emerald-500"}`}>{saveMsg}</span>}
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
          <button onClick={handleDedup} disabled={saving || editDirty} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40" title="중복 entry 제거 및 documents citation citekey 통일">
            <FilterX className="h-3.5 w-3.5" />
            중복 제거
          </button>
          <button onClick={handleValidateAndClean} disabled={saving || editDirty || dirty} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40" title="미사용 entry 제거 후 Crossref 서지정보와 NLM 저널 약어 검증">
            <ShieldCheck className="h-3.5 w-3.5" />
            {validationProgress ? "검증 중" : "정리 · 검증"}
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

      {externalContent !== null && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            references.bib changed outside ScholarPen while this tab had an unsaved entry edit. The external file has not been overwritten.
          </span>
          <button
            onClick={handleReloadExternal}
            className="rounded border border-amber-400/70 px-2 py-1 font-medium transition-colors hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-950"
          >
            Load external file
          </button>
        </div>
      )}

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
                  <input
                    ref={bibtexImportRef}
                    type="file"
                    accept=".bib,text/x-bibtex,text/plain"
                    onChange={handleMergeBibtexFile}
                    className="hidden"
                    aria-label="Select a BibTeX file to merge"
                  />
                  <button
                    onClick={() => bibtexImportRef.current?.click()}
                    disabled={saving || dirty || editDirty || externalContent !== null}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                    title="외부 .bib 파일을 병합하고 중복 entry만 건너뜁니다"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Merge .bib
                  </button>
                  <button onClick={handleAppendEntry} disabled={saving || !addDraft.trim()} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40" title="새 BibTeX entry append">
                    <FilePlus2 className="h-3.5 w-3.5" />
                    Append
                  </button>
                </div>
                <textarea
                  value={addDraft}
                  onChange={(e) => setAddDraft(e.target.value)}
                  placeholder={"@article{citekey,...}\n\n@book{anotherkey,...}"}
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
            {validationProgress && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-foreground">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 animate-pulse text-primary" />
                  <span>{validationProgress.message}</span>
                </div>
                {validationProgress.total > 0 && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width]"
                      style={{ width: `${Math.round((validationProgress.processed / validationProgress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            {validationResult && (
              <BibliographyValidationReview
                result={validationResult}
                applying={saving}
                onApply={handleApplyValidation}
              />
            )}
            {parsed.issues.length > 0 && (
              <section className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">BibTeX integrity issues</div>
                    <p className="mt-1 text-xs opacity-80">
                      유효하지 않은 bibliography에는 새 entry를 추가하거나 저장할 수 없습니다. 위치를 확인한 뒤 안전 보정 또는 AI 보정을 검토하세요.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleProposeRepair("deterministic")}
                      disabled={saving || repairing !== null}
                      className="flex items-center gap-1 rounded border border-red-300/70 px-2 py-1 text-xs transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-900 dark:hover:bg-red-950"
                      title="명확한 brace 누락처럼 안전하게 판단할 수 있는 syntax만 보정"
                    >
                      <Wrench className="h-3.5 w-3.5" />
                      {repairing === "deterministic" ? "분석 중" : "안전 보정"}
                    </button>
                    <button
                      onClick={() => handleProposeRepair("llm")}
                      disabled={saving || repairing !== null}
                      className="flex items-center gap-1 rounded border border-red-300/70 px-2 py-1 text-xs transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-900 dark:hover:bg-red-950"
                      title="현재 Sidebar provider/model로 syntax-only repair proposal 생성"
                    >
                      <WandSparkles className="h-3.5 w-3.5" />
                      {repairing === "llm" ? "AI 분석 중" : "AI 보정 제안"}
                    </button>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {parsed.issues.map((issue) => (
                    <div key={`${issue.code}-${issue.offset}`} className="rounded border border-red-300/70 bg-background/60 p-2.5 dark:border-red-900/70">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold">{parseIssueLabel(issue.code)}</span>
                        {issue.entryHint && <span className="font-mono">{issue.entryHint}</span>}
                        <span className="opacity-75">line {issue.line}, column {issue.column} · offset {issue.offset}</span>
                        <button
                          onClick={() => focusRepairIssue(issue)}
                          className="ml-auto rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-red-100 dark:hover:bg-red-950"
                        >
                          소스 위치 열기
                        </button>
                      </div>
                      <p className="mt-1 text-xs">{issue.message}</p>
                      <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 font-mono text-[11px] leading-4 text-foreground">{issue.context}</pre>
                    </div>
                  ))}
                </div>

                <div className="mt-3 rounded border border-border bg-background/70">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
                    <div>
                      <span className="font-semibold text-foreground">Repair preview</span>
                      {repairProposal && (
                        <span className="ml-2 text-muted-foreground">
                          {repairProposal.method === "llm"
                            ? `${repairProposal.provider}/${repairProposal.model}`
                            : "deterministic syntax repair"}
                        </span>
                      )}
                    </div>
                    <span className={repairDraftParsed.issues.length === 0 ? "text-emerald-500" : "text-red-400"}>
                      {repairDraftParsed.issues.length === 0
                        ? `${repairDraftParsed.entries.length} entries · syntax valid`
                        : `${repairDraftParsed.issues.length} issues remain`}
                    </span>
                  </div>
                  <textarea
                    ref={repairEditorRef}
                    value={repairDraft}
                    onChange={(event) => {
                      setRepairDraft(event.target.value);
                      setRepairProposal(null);
                    }}
                    spellCheck={false}
                    className="h-64 w-full resize-y bg-transparent p-3 font-mono text-xs leading-5 text-foreground outline-none"
                    aria-label="Bibliography syntax repair editor"
                  />
                  <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
                    <button
                      onClick={() => {
                        setRepairDraft(content);
                        setRepairProposal(null);
                      }}
                      disabled={repairDraft === content}
                      className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                    >
                      제안 취소
                    </button>
                    <button
                      onClick={handleApplyRepair}
                      disabled={saving || repairDraft === content || repairDraftParsed.issues.length > 0}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-opacity disabled:opacity-40"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      검증 후 보정 반영
                    </button>
                  </div>
                </div>
              </section>
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
                  <p className="text-xs text-muted-foreground">Citekey, DOI, or title-author-year duplicates are grouped. Cleanup also remaps citations across all documents.</p>
                </div>
                <button onClick={handleDedup} disabled={saving || editDirty || duplicateGroups.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40">
                  <FilterX className="h-3.5 w-3.5" />
                  중복 제거 + 인용 통일
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
