import React, { useEffect, useState } from "react";
import { Brain, ExternalLink, Trash2 } from "lucide-react";
import { rpc } from "../../rpc";
import type { AuthorLearningView } from "../../../shared/author-learning";
import type { ProjectMemoryStatus } from "../../../shared/project-memory";

export function AuthorLearningPanel({ projectPath }: { projectPath: string }) {
  const [view, setView] = useState<AuthorLearningView | null>(null);
  const [memory, setMemory] = useState<ProjectMemoryStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const [learning, status] = await Promise.allSettled([rpc.getAuthorLearning(projectPath), rpc.getProjectMemoryStatus(projectPath)]);
      if (!active) return;
      if (learning.status === "fulfilled") { setView(learning.value); setError(""); }
      else setError(String(learning.reason));
      if (status.status === "fulfilled") setMemory(status.value);
    };
    setView(null); setMemory(null); void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [projectPath]);
  const dismiss = async (id: string) => {
    try { setView(await rpc.dismissAuthorPreference(projectPath, id)); }
    catch (reason) { setError(String(reason)); }
  };
  return <section className="border-b border-border px-3 py-3 text-xs" aria-label="학습한 편집 취향">
    <div className="flex items-center gap-2 font-medium"><Brain className="h-3.5 w-3.5" />학습한 편집 취향
      <span className="ml-auto text-[11px] font-normal text-muted-foreground">{view?.state === "learning" ? "분석 중" : "자동 관찰"}</span>
    </div>
    <p className="mt-2 leading-5 text-muted-foreground">직접 고친 문장과 AI 제안의 수락·거절에서 반복되는 선호를 배웁니다. 서로 다른 문단 3곳 이상에서 확인된 취향을 다음 AI 편집에 반영합니다.</p>
    <p className="mt-2 text-[11px] text-muted-foreground">최근 관찰 {view?.observations.length ?? 0}건 · 편집에 반영할 취향 {view?.preferences.length ?? 0}개</p>
    {view?.preferences.length ? <ul className="mt-2 space-y-2">{view.preferences.map(preference => <li key={preference.id} className="rounded border border-border p-2">
      <div className="flex gap-2"><p className="flex-1">{preference.rule}</p><button type="button" aria-label="이 학습 제외" title="이 해석과 그 근거를 향후 학습에서 제외" onClick={() => void dismiss(preference.id)} className="self-start rounded p-1 hover:bg-muted"><Trash2 className="h-3 w-3" /></button></div>
      <p className="mt-1 text-[11px] text-muted-foreground">{preference.scope} · 근거 {preference.evidenceIds.length}건</p>
      <details className="mt-1 text-[11px]"><summary className="cursor-pointer">학습 근거 보기</summary>{view.observations.filter(o => preference.evidenceIds.includes(o.id)).map(o => <p key={o.id} className="mt-2 whitespace-pre-wrap">{o.filename} · {o.kind === "direct-edit" ? "직접 수정" : o.kind === "accepted" ? "제안 수락" : "제안 거절"}<br />이전: {o.before}<br />{o.kind === "rejected" ? "거절한 제안" : "이후"}: {o.after}</p>)}</details>
    </li>)}</ul> : <p className="mt-2 text-[11px] leading-5 text-muted-foreground">아직 반복된 취향을 확정할 근거가 충분하지 않습니다. 평소처럼 편집하시면 됩니다. 한 번의 수정은 일반적인 취향으로 단정하지 않습니다.</p>}
    {!!view?.observations.length && <details className="mt-2 text-[11px]"><summary className="cursor-pointer">최근 편집 관찰 보기</summary>{view.observations.slice(0, 5).map(o => <div key={o.id} className="mt-2 border-l-2 border-border pl-2"><p>{o.filename} · {o.kind === "direct-edit" ? "직접 수정" : o.kind === "accepted" ? "제안 수락" : "제안 거절"}</p><p className="mt-1 text-muted-foreground">{o.direction || `${o.before.slice(0, 100)} → ${o.after.slice(0, 100)}`}</p></div>)}</details>}
    <div className="mt-3 flex items-center gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
      <span>{memory?.state === "ready" ? `Hindsight 기억 ${memory.memories ?? 0}건${memory.pending ? ` · 처리 중 ${memory.pending}건` : ""}` : memory?.state === "unavailable" ? "Hindsight 연결 확인 필요 · 관찰은 로컬에 보존" : "Hindsight 확인 중…"}</span>
      {memory?.bankId && <button type="button" aria-label="프로젝트 bank 열기" title="프로젝트 bank 열기" onClick={() => void rpc.openExternal(`${memory.url}/banks/${encodeURIComponent(memory.bankId!)}`)}><ExternalLink className="h-3 w-3" /></button>}
    </div>
    {(error || view?.error) && <p role="alert" className="mt-2 text-amber-700 dark:text-amber-300">{error || view?.error}</p>}
  </section>;
}
