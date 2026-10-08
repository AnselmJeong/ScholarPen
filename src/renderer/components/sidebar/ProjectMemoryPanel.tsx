import React, { useCallback, useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MEMORY_CONTENT_LIMIT, type ProjectMemoryStatus, type ProjectMemoryHit, type ProjectMemoryReceipt } from "@shared/project-memory";
import { rpc } from "../../rpc";

function readDraft(projectPath: string): { content: string; source: string; receipt: ProjectMemoryReceipt | null } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`scholarpen-memory:${projectPath}`) || "null");
    if (saved && typeof saved === "object" && "content" in saved && typeof saved.content === "string" && "source" in saved && typeof saved.source === "string") {
      const receipt = "receipt" in saved ? saved.receipt : null;
      return { content: saved.content, source: saved.source, receipt: receipt && typeof receipt === "object" && "operationId" in receipt && typeof receipt.operationId === "string" ? { state: "processing", operationId: receipt.operationId } : null };
    }
  } catch { /* Storage can be unavailable in browser previews. */ }
  return { content: "", source: "", receipt: null };
}

export function ProjectMemoryPanel({ projectPath, sourceName, getSelection }: {
  projectPath: string;
  sourceName?: string | null;
  getSelection: () => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<ProjectMemoryStatus | null>(null);
  const [draft] = useState(() => readDraft(projectPath));
  const [content, setContent] = useState(draft.content);
  const [source, setSource] = useState(draft.source);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProjectMemoryHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(draft.receipt ? "접수된 기억의 처리 상태를 확인하는 중입니다…" : "");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ProjectMemoryReceipt | null>(draft.receipt);
  useEffect(() => {
    try { localStorage.setItem(`scholarpen-memory:${projectPath}`, JSON.stringify({ content, source, receipt })); }
    catch { /* Keep the visible draft even if local storage is unavailable. */ }
  }, [projectPath, content, source, receipt]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const next = await rpc.getProjectMemoryStatus(projectPath);
      if (alive.current) setStatus(next);
    } catch (err) { if (alive.current) setError(String(err)); }
    finally { if (alive.current) setBusy(false); }
  }, [projectPath]);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!receipt) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const operation = await rpc.getProjectMemoryOperation(projectPath, receipt.operationId);
        if (cancelled) return;
        if (operation.state === "completed") {
          setReceipt(null); setNotice("기억 저장이 완료되었습니다. 이후 AI 질문에서 관련 내용을 자동으로 참조합니다.");
          setContent(""); setSource("");
        } else if (operation.state === "failed") {
          setReceipt(null); setNotice(""); setError("Hindsight가 기억을 처리하지 못했습니다. 내용을 유지했습니다. 다시 저장해 주세요.");
        } else { timer = setTimeout(poll, 5_000); }
      } catch (err) {
        if (!cancelled) {
          setNotice("저장 요청은 접수되었지만 처리 상태를 확인하지 못했습니다. Hindsight에서 확인할 수 있습니다.");
          timer = setTimeout(poll, 15_000);
        }
      }
    };
    timer = setTimeout(poll, 2_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectPath, receipt]);

  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await rpc.retainProjectMemory(projectPath, content, source);
      // Preserve acknowledgement even if the user switched projects during the request.
      try { localStorage.setItem(`scholarpen-memory:${projectPath}`, JSON.stringify({ content, source, receipt: next })); } catch { /* Visible state remains usable. */ }
      if (alive.current) { setReceipt(next); setNotice("Hindsight가 저장 요청을 접수했습니다. 기억을 처리하는 중입니다…"); }
    } catch (err) { if (alive.current) setError(String(err)); }
    finally { if (alive.current) setBusy(false); }
  }

  async function search() {
    setBusy(true); setError(""); setHits(null);
    try { const next = await rpc.recallProjectMemory(projectPath, query); if (alive.current) setHits(next); }
    catch (err) { if (alive.current) setError(String(err)); }
    finally { if (alive.current) setBusy(false); }
  }

  return <section className="shrink-0 border-b border-border text-xs" aria-label="프로젝트 기억">
    <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      <Brain className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium">프로젝트 기억</span>
      <span className="ml-auto text-muted-foreground">{status?.state === "ready" ? "Hindsight 연결됨" : status?.state === "unavailable" || error ? "연결 확인 필요" : "연결 중…"}</span>
    </button>
    {expanded && <div className="max-h-[45vh] space-y-3 overflow-y-auto px-3 pb-3">
      <p className="text-muted-foreground">연구 결정, 용어 정의, 참고할 내용을 남기세요. 저장한 기억은 이 프로젝트의 AI 질문에 자동으로 참조됩니다.</p>
      {status?.state === "unavailable" && <p role="alert" className="text-amber-700 dark:text-amber-300">{status.error}</p>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>연결 재시도</Button>
        {status && <Button variant="ghost" size="sm" onClick={() => { void rpc.openExternal(`${status.url}/banks/${encodeURIComponent(status.bankId || "")}`).catch(err => setError(String(err))); }}>Hindsight 열기</Button>}
      </div>
      {status?.bankId && <p className="break-all text-[10px] text-muted-foreground">Bank: {status.bankId}</p>}
      <label className="block space-y-1"><span>기억할 내용</span>
        <textarea aria-label="기억할 내용" className="min-h-24 w-full resize-y rounded-md border border-input bg-background p-2 text-xs" maxLength={MEMORY_CONTENT_LIMIT} value={content} disabled={busy || Boolean(receipt)} onChange={e => setContent(e.target.value)} placeholder="예: 이 원고에서는 state와 phase를 구분하여 사용한다. 근거와 출처도 함께 남겨 주세요." />
      </label>
      <Input aria-label="기억 출처" className="h-8 text-xs" placeholder="출처 또는 맥락 (선택)" value={source} maxLength={500} disabled={busy || Boolean(receipt)} onChange={e => setSource(e.target.value)} />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy || Boolean(receipt)} onMouseDown={e => e.preventDefault()} onClick={() => {
          const selection = getSelection();
          if (!selection.trim()) { setError("문서에서 기억할 부분을 먼저 선택해 주세요."); return; }
          if (selection.length > MEMORY_CONTENT_LIMIT) { setError("선택한 내용이 너무 깁니다. 더 짧은 부분을 선택해 주세요."); return; }
          setContent(selection); setSource(sourceName || "문서 선택문"); setError("");
        }}>선택문 가져오기</Button>
        <Button size="sm" disabled={busy || Boolean(receipt) || !content.trim()} onClick={() => void save()}>기억 저장</Button>
      </div>
      {notice && <p role="status" className="text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-amber-700 dark:text-amber-300">{error}</p>}
      <form className="flex gap-2 border-t border-border pt-3" onSubmit={e => { e.preventDefault(); if (query.trim() && !busy) void search(); }}>
        <Input aria-label="기억 검색어" className="h-8 text-xs" value={query} onChange={e => setQuery(e.target.value)} placeholder="저장한 기억 검색" />
        <Button size="sm" variant="outline" disabled={busy || !query.trim()}>검색</Button>
      </form>
      {hits?.length === 0 && <p className="text-muted-foreground">관련 기억이 없습니다. 저장 처리 중인 내용은 완료 후 검색됩니다.</p>}
      {hits && hits.length > 0 && <ul className="space-y-2">{hits.map(hit => <li key={hit.id} className="rounded border border-border p-2"><p className="whitespace-pre-wrap">{hit.text}</p>{hit.context && <p className="mt-1 text-muted-foreground">{hit.context}</p>}</li>)}</ul>}
    </div>}
  </section>;
}
