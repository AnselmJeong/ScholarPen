import { ReviewProgress } from "./ReviewProgress";
import { reviewStageLabel } from "../../../shared/review-session/progress-labels";
import React, { useCallback, useEffect, useState } from "react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, CheckCircle2, ClipboardCheck, Download, FilePlus2, Loader2, Pause, Play, Plus, X } from "lucide-react";
import { rpc } from "../../rpc";
import { DEFAULT_REVIEWERS, type ReviewExportFormat, type ReviewInput, type ReviewSession, type ReviewView, type ReviewAddress, type FigureApproval } from "../../../shared/review-session/types";
import type { FileNode, ProjectInfo } from "../../../shared/rpc-types";
import { collectSearchDocumentNodes } from "../../utils/document-tree";
const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";
const button = "inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed";
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const dispositionLabels: Record<string, string> = { changed: "수정 반영", "clarified-no-change": "기존 설명 안내", "reasoned-disagreement": "근거 있는 반박", "partially-addressed": "일부 반영", "needs-author": "저자 판단 필요", "awaiting-figure-approval": "그림 승인 대기", unresolved: "미해결" };
const qualityLabels: Record<string, string> = { "not-assessed": "검토 전", "ready-for-author-review": "저자 최종 검토 가능", "needs-author-action": "저자 판단 필요", "incomplete-coverage": "미검토 자료 있음" };
interface Props { project: ProjectInfo; files: FileNode[]; activeDocument: string | null; prepare: () => Promise<void>; saveResponses?: () => Promise<void>; onClose: () => void; onExported: () => Promise<void>; onOpenRevision: (path: string, filename: string) => Promise<void> }
export function ReviewWorkspace({ project, files, activeDocument, prepare, saveResponses, onClose, onExported, onOpenRevision }: Props) {
  const [sessions, setSessions] = useState<ReviewSession[]>([]);
  const [view, setView] = useState<ReviewView | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastCheckedAt, setLastCheckedAt] = useState(0);
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"comments" | "changes" | "response" | "figures" | "report" | "manuscript">("comments");
  const [exportFormat, setExportFormat] = useState<ReviewExportFormat>("json");
  const [exportRound, setExportRound] = useState(0);
  const [commentId, setCommentId] = useState<string | null>(null);
  const refresh = useCallback(async (id?: string) => {
    const list = await rpc.reviewList(project.path); setSessions(list);
    if (id) { await saveResponses?.(); setView(await rpc.reviewGet({ projectPath: project.path, sessionId: id })); setExportRound(0); setLastCheckedAt(Date.now()); setConnectionError(""); }
  }, [project.path, saveResponses]);
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [refresh]);
  useEffect(() => {
    if (!view || view.session.status !== "running") return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await rpc.reviewGet({ projectPath: project.path, sessionId: view.session.id }); if (!cancelled) { setView(next); setLastCheckedAt(Date.now()); setConnectionError(""); } }
      catch (e) { if (!cancelled) setConnectionError(String(e)); }
      if (!cancelled) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500); return () => { cancelled = true; clearTimeout(timer); };
  }, [project.path, view?.session.id, view?.session.status]);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  useEffect(() => { if (view?.session.status === "completed") void onExported(); }, [view?.session.id, view?.session.status, onExported]);
  const s = view?.session; const address = s ? { projectPath: project.path, sessionId: s.id } : null;
  const result = s?.rounds.find(r => r.round === s.selectedFinalRound) ?? s?.rounds.at(-1);
  const selectedComment = s?.comments.find(c => c.id === commentId) ?? s?.comments[0];
  const responses = view?.responseError ? [] : view?.responseDocument?.responses ?? result?.responses ?? [];
  const selectedResponse = responses.find(r => r.commentId === selectedComment?.id);
  const editedIds = view?.responseDocument?.editedCommentIds ?? [];
  const exportResponses = () => action(async () => {
    await saveResponses?.();
    const path = await rpc.reviewExportResponses(address!);
    await refresh(s!.id);
    setNotice(`전체 심사의견과 최신 답변을 저장했습니다. HTML 파일을 열어 인쇄하거나 PDF로 저장할 수 있습니다: ${path}/response-to-reviewers.html (Markdown 포함)`);
    await onExported();
  });
  return <section className="absolute inset-0 z-20 flex flex-col bg-background" aria-label="Review & Revision">
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
      <button className={button} onClick={onClose} aria-label="Close Review & Revision"><ArrowLeft size={15} /></button>
      <ClipboardCheck className="text-primary" size={22} /><div className="flex-1"><h1 className="text-base font-semibold">Review & Revision</h1><p className="text-xs text-muted-foreground">{project.name} · 원본을 보존하는 심사 대응 작업 공간</p></div>
      <button className={button} onClick={() => { setCreating(true); setView(null); setNotice(""); }}><Plus size={14} />새 세션</button>
    </header>
    {error && <div role="alert" className="mx-5 mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
    {notice && <div role="status" className="mx-5 mt-3 rounded-lg border border-border bg-accent p-3 text-sm break-all">{notice}</div>}
    {creating ? <ReviewSetup project={project} files={files} activeDocument={activeDocument} busy={busy} onCancel={() => setCreating(false)} onCreate={input => action(async () => {
      await prepare(); const { verifyReviewSnapshots } = await import("./verify-snapshots"); await verifyReviewSnapshots(project.path, input.documents); const created = await rpc.reviewCreate(input); setCreating(false); setView(await rpc.reviewGet({ projectPath: project.path, sessionId: created.id })); await refresh(created.id);
    })} /> : !view ? <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl"><h2 className="mb-2 text-xl font-semibold">논문 전체를 함께 검토합니다</h2><p className="mb-6 text-sm leading-6 text-muted-foreground">GPT의 심사와 Claude의 통합 수정·답변을 연결합니다. 최대 두 회차 뒤에 원고, 답변서, 변경표와 미해결 사항을 함께 검토할 수 있습니다.</p>
        {!sessions.length && <div className="rounded-xl border border-dashed border-border px-8 py-10 text-center"><ClipboardCheck className="mx-auto mb-3 text-primary" size={30} /><p className="mb-4 text-sm">아직 저장된 심사 세션이 없습니다.</p><button className={primary} onClick={() => setCreating(true)}>첫 심사 세션 만들기</button></div>}
        <div className="space-y-3">{sessions.map(item => <button key={item.id} onClick={() => action(() => refresh(item.id))} className="block w-full rounded-xl border border-border p-4 text-left hover:bg-accent"><div className="flex justify-between gap-3"><strong className="text-sm">{item.input.mode === "virtual" ? "가상 심사" : "실제 심사 대응"}</strong><span className="text-xs text-muted-foreground">{item.status} · {item.completedCycles}/{item.input.maxCycles}회</span></div><p className="mt-2 text-sm">{item.input.documents.join(", ")}</p><p className="mt-2 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()} · {qualityLabels[item.quality]}</p></button>)}</div>
      </div>
    </div> : <>
      <div className="shrink-0 border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-2"><button className={button} onClick={() => { setView(null); void refresh(); }}>세션 목록</button><span className="rounded-full bg-accent px-3 py-1 text-xs">{s!.input.mode === "virtual" ? "가상 심사" : "실제 심사 대응"}</span><span className="text-sm font-medium">{reviewStageLabel(s!.stage)} · {s!.completedCycles}/{s!.input.maxCycles}회 완료</span><span className="ml-auto text-xs text-muted-foreground">{s!.status === "running" ? "검토 진행 중" : qualityLabels[s!.quality]}</span></div>
        <p className="mt-2 text-xs text-muted-foreground">GPT {s!.roles.reviewer.model} → Claude {s!.roles.reviser.model} · 기준본 {new Date(s!.createdAt).toLocaleString()} · 예약된 수정 {s!.allocatedCycles}회</p>
        <p className="mt-1 text-xs text-muted-foreground break-all">편집할 원고: {s!.editablePath ?? `${project.path}/revisions/${s!.id}`}/documents</p>
        {s!.error && <p className="mt-2 rounded-lg bg-amber-500/10 p-2 text-sm">{s!.status === "paused" && s!.stage.startsWith("awaiting-figure-approval") ? "이전 버전에서 그림 교체를 기다리며 중단된 세션입니다. ‘저장된 단계부터 재개’를 누르면 대체 파일이 없는 그림은 원본을 유지하고, 답변서에 확인 요청을 남기며 계속 진행합니다." : /No-change response|Every original comment|Empty response|Response cites a change|Changed response|Incomplete GPT comment|integrated plan must address|Unknown figure request|Duplicate requests for the same figure/.test(s!.error) ? "이전 버전에서 AI 답변·계획의 부족한 내용 때문에 중단된 세션입니다. ‘저장된 단계부터 재개’를 누르면 확인할 항목을 기록하고 가능한 검토를 계속합니다." : s!.error}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {!["running", "completed", "cancelled"].includes(s!.status) && <button disabled={busy} className={primary} onClick={() => action(async () => { await rpc.reviewStart(address!); await refresh(s!.id); })}><Play size={13} />{s!.status === "created" ? "심사·수정 시작" : "저장된 단계부터 재개"}</button>}
          {s!.status === "running" && <button disabled={busy} className={button} onClick={() => action(async () => { await rpc.reviewStop(address!); await refresh(s!.id); })}><Pause size={13} />일시정지</button>}
          {!["completed", "cancelled", "created"].includes(s!.status) && <button disabled={busy} className={button} onClick={() => action(async () => { await rpc.reviewStop(address!, true); await refresh(s!.id); })}><X size={13} />실행 취소</button>}
          {s!.status === "completed" && <><button disabled={busy} className={button} onClick={() => action(async () => { const next = await rpc.reviewFollowup(address!); await refresh(next.id); })}>최종 후보로 후속 세션 만들기</button><button disabled={busy} className={button} onClick={() => action(async () => { await saveResponses?.(); await prepare(); setNotice(`최신 원고·답변서 내보내기: ${await rpc.reviewExport(address!)}`); await onExported(); })}><Download size={13} />최신 원고·답변서 내보내기</button><button disabled={busy} className={button} onClick={() => action(async () => { const path = await rpc.reviewExport(address!, true); await onExported(); await onOpenRevision(path, s!.input.documents[0]!); })}><FilePlus2 size={13} />수정 원고에서 계속 편집</button></>}
          {s!.rounds.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
            <select aria-label="내보낼 리뷰 회차" className="rounded border border-border bg-background px-2 py-1 text-xs" value={exportRound || s!.selectedFinalRound || s!.rounds.at(-1)!.round} onChange={e => setExportRound(Number(e.target.value))}>
              {s!.rounds.map(r => <option key={r.round} value={r.round}>{r.round}차 원고{r.round === s!.selectedFinalRound ? " · 최종 후보" : ""}</option>)}
            </select>
            <select aria-label="리뷰 원고 내보내기 형식" className="rounded border border-border bg-background px-2 py-1 text-xs" value={exportFormat} onChange={e => setExportFormat(e.target.value as ReviewExportFormat)}>
              <option value="qmd">Quarto (.qmd)</option><option value="md">Markdown (.md)</option><option value="json">ScholarPen (.scholarpen.json)</option>
            </select>
            <button disabled={busy || s!.status === "running"} className={button} onClick={() => action(async () => {
              const { exportManuscripts } = await import("./export-manuscripts");
              const path = await exportManuscripts(address!, exportRound || s!.selectedFinalRound || s!.rounds.at(-1)!.round, exportFormat);
              setNotice(`원고와 그림·참고문헌을 exports 폴더에 저장했습니다: ${path}`);
              await onExported();
            })}><Download size={13} />자동 검토 원고 내보내기</button>
          </div>}
          {busy && <Loader2 size={16} className="animate-spin self-center" />}
        </div>
      </div>
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-5" aria-label="Review result tabs">{([ ["comments", "의견과 답변"], ["changes", "변경 비교"], ["manuscript", "원고 열람"], ["response", "답변서"], ["figures", "그림 확인"], ["report", "계획·검증"] ] as const).map(([id, label]) => <button key={id} disabled={busy} onClick={() => { setTab(id); if (id === "response" || id === "comments") void action(() => refresh(s!.id)); }} className={`whitespace-nowrap border-b-2 px-3 py-3 text-xs ${tab === id ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground"}`}>{label}{id === "figures" && s!.approvals.filter(a => a.status === "pending" && a.round > s!.completedCycles).length > 0 ? ` (${s!.approvals.filter(a => a.status === "pending" && a.round > s!.completedCycles).length})` : ""}</button>)}</nav>
      <div className="min-h-0 flex-1 overflow-auto"><ReviewProgress view={view} lastCheckedAt={lastCheckedAt} connectionError={connectionError} />
        {view.responseError && <p role="alert" className="m-5 rounded border border-destructive/30 p-3 text-sm text-destructive">{view.responseError}</p>}
        {tab === "comments" && <div className="grid min-h-full grid-cols-[220px_1fr]">
          <aside className="border-r border-border p-3">{!s!.comments.length && <p className="p-2 text-xs text-muted-foreground">{s!.status === "running" ? "원고 문맥 분석 후 심사의견이 표시됩니다." : "정리된 심사의견이 여기에 표시됩니다."}</p>}{s!.comments.map(c => <button key={c.id} onClick={() => setCommentId(c.id)} className={`mb-2 w-full rounded-lg p-3 text-left text-xs ${selectedComment?.id === c.id ? "bg-primary/10 text-primary" : "hover:bg-accent"}`}><strong>{c.reviewerId} · {c.id}</strong><p className="mt-1 line-clamp-3 leading-5">{c.original}</p><p className="mt-2 text-muted-foreground">{editedIds.includes(c.id) ? "저자 수정 답변" : dispositionLabels[responses.find(r => r.commentId === c.id)?.disposition ?? ""] ?? "대응 전"}</p></button>)}</aside>
          <article className="space-y-5 p-6">{selectedComment ? <><div><h3 className="mb-2 text-xs font-semibold text-muted-foreground">심사의견 원문 · {selectedComment.source === "human" ? "실제 의견" : "가상 의견"}</h3><p className="whitespace-pre-wrap text-sm leading-7">{selectedComment.original}</p></div>{selectedResponse && <><div className="border-t border-border pt-4"><h3 className="mb-2 text-xs font-semibold text-primary">{editedIds.includes(selectedResponse.commentId) ? "저자가 수정한 최신 답변 · 원고와의 일치 확인 필요" : `AI 답변 · ${dispositionLabels[selectedResponse.disposition]} · ${selectedResponse.verification}`}</h3><p className="whitespace-pre-wrap text-sm leading-7">{selectedResponse.response}</p></div><p className="break-all text-xs text-muted-foreground">자동 검토 당시 위치: {selectedResponse.locations.join("; ") || "변경 없음"}<br />연결된 변경: {selectedResponse.changeIds.join(", ") || "없음"}</p></>}</> : <p className="text-sm text-muted-foreground">{s!.status === "running" ? "검토가 진행 중입니다. 위에서 현재 작업과 최근 완료 단계를 확인할 수 있습니다." : s!.status === "created" ? "심사·수정 시작 버튼을 누르면 검토를 시작합니다." : "진행 상황과 중단 안내를 확인해 주세요."}</p>}</article>
        </div>}
        {tab === "changes" && <div className="space-y-5 p-5">{!view.changes.length && <p className="text-sm text-muted-foreground">완료된 회차의 실제 변경이 여기에 표시됩니다.</p>}{view.changes.map(c => <article key={c.id} className="overflow-hidden rounded-xl border border-border"><div className="border-b border-border bg-accent/40 px-4 py-3 text-xs"><strong>{c.id}</strong> · {c.commentIds.join(", ")}<p className="mt-1 break-all text-muted-foreground">{c.target}</p></div><div className="grid grid-cols-2"><div className="border-r border-border bg-red-500/5 p-4"><h4 className="mb-2 text-xs font-semibold">변경 전</h4><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">{c.before}</pre></div><div className="bg-emerald-500/5 p-4"><h4 className="mb-2 text-xs font-semibold">변경 후</h4><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">{c.after}</pre></div></div><p className="border-t border-border p-3 text-xs text-muted-foreground">{c.rationale}</p></article>)}</div>}
        {tab === "response" && <div className="p-6">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4"><div><h2 className="text-base font-semibold">전체 심사의견과 답변</h2><p className="mt-2 text-xs leading-6 text-muted-foreground">{view.responseDocument?.source === 'revision' ? `수정 작업 폴더의 최신 저장본 · 의견 ${s!.comments.length}개 · 저자 수정 ${editedIds.length}개. 수정한 원고와 답변의 일치를 확인해 주세요.` : '자동 검토 당시 답변입니다. 아직 저장된 수정 답변서가 없습니다.'}</p></div><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => action(() => refresh(s!.id))}>최신 답변 불러오기</button><button className={primary} disabled={busy || s!.status !== 'completed' || !!view.responseError} onClick={exportResponses}><Download size={14} />전체 답변서 내보내기</button></div></div>
          {view.responsesMarkdown ? <article aria-label="전체 답변서 미리보기" className="prose prose-sm max-w-none break-words dark:prose-invert prose-blockquote:whitespace-pre-wrap prose-blockquote:not-italic"><ReactMarkdown remarkPlugins={[remarkGfm]}>{view.responsesMarkdown}</ReactMarkdown></article> : <p className="text-sm text-muted-foreground">{view.responseError ? '최신 답변서를 불러오지 못했습니다.' : '답변 생성 전입니다.'}</p>}
        </div>}
        {tab === "figures" && <div className="space-y-4 p-5"><p className="text-sm leading-6 text-muted-foreground">대체 파일이 없는 그림은 원본을 유지하고 답변서에 저자 확인 사항으로 남깁니다. 검토는 계속 진행됩니다. 이 앱은 그림을 자동 생성하지 않습니다. 일시정지된 회차에 새 그림을 반영하려면 교체를 허용한 뒤 PNG/JPEG/WebP/GIF 파일을 가져오세요.</p>{!s!.approvals.length && <p className="text-sm">그림 수정 요청이 없습니다.</p>}{s!.approvals.map(a => <FigureCard key={a.id} address={address!} approval={a} sealed={a.round <= s!.completedCycles || s!.status === "cancelled"} busy={busy} onAction={fn => action(async () => { await fn(); await refresh(s!.id); })} />)}</div>}
        {tab === "manuscript" && <ManuscriptPreview address={address!} session={s!} />}
        {tab === "report" && <div className="space-y-5 p-6"><div className="rounded-xl border border-border p-4"><h3 className="mb-2 font-semibold">{qualityLabels[s!.quality]}</h3><p className="text-sm text-muted-foreground">GPT의 내부 점검 결과입니다. 실제 게재 가능성이나 저널 제출 완료를 뜻하지 않습니다.</p><p className="mt-3 text-xs">{s!.input.baselineNote || "기준본에 대한 추가 설명 없음"}</p></div>{s!.warnings?.map((w, i) => <p key={`review-warning-${i}`} className="text-sm text-amber-700">{reviewStageLabel(w.stage)}: {w.reason}</p>)}{s!.manifest.warnings.map((w, i) => <p key={i} className="text-sm text-amber-700">{w}</p>)}{s!.rounds.map(r => <article key={r.round} className="space-y-3 rounded-xl border border-border p-4"><h3 className="font-semibold">{r.round}차 결과 {r.round === s!.selectedFinalRound ? "· 최종 후보" : ""}</h3><p className="whitespace-pre-wrap text-sm leading-6">{r.plan.argumentMap}</p><p className="whitespace-pre-wrap text-sm leading-6">{r.plan.principles.join("\n")}</p>{r.plan.conflicts.length > 0 && <div className="text-sm">충돌 조정: {r.plan.conflicts.join("\n")}</div>}<p className="whitespace-pre-wrap text-sm leading-6">{r.assessment.summary}</p>{r.assessment.issues.map((x, i) => <p key={i} className="text-sm text-amber-700">{x}</p>)}<details><summary className="cursor-pointer text-xs">검증과 전체 읽기 범위</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs leading-5">{r.validation.join("\n")}{"\n\n"}{r.coverage.map(c => `${c.target}: ${c.status} — ${c.detail}`).join("\n")}</pre></details></article>)}</div>}
      </div>
    </>}
  </section>;
}
function ReviewSetup({ project, files, activeDocument, busy, onCancel, onCreate }: { project: ProjectInfo; files: FileNode[]; activeDocument: string | null; busy: boolean; onCancel: () => void; onCreate: (input: ReviewInput) => Promise<void> }) {
  const names = collectSearchDocumentNodes(files, project.path).map(n => n.path.slice(`${project.path}/documents/`.length));
  const [input, setInput] = useState<ReviewInput>({ projectPath: project.path, documents: [...names], mode: "virtual", maxCycles: 2, reviewerModel: "", reviserModel: "", reviewers: structuredClone(DEFAULT_REVIEWERS), decisionLetter: "", language: "English", authorConstraints: "", baselineNote: "현재 저장된 원고를 기준본으로 사용" });
  const [models, setModels] = useState<{ codex: string[]; claude: string[] }>({ codex: [], claude: [] }); const [connection, setConnection] = useState("구독 연결 확인 중…");
  useEffect(() => { let stopped = false; void Promise.all([rpc.listProviderModels("codex"), rpc.listProviderModels("anthropic"), rpc.getCodexStatus(), rpc.getClaudeStatus()]).then(([codex, claude, cs, as]) => { if (stopped) return; setModels({ codex, claude }); setInput(v => ({ ...v, reviewerModel: codex[0] ?? "", reviserModel: claude[0] ?? "" })); setConnection(`GPT: ${cs.state} · Claude: ${as.state}`); }).catch(e => { if (!stopped) setConnection(String(e)); }); return () => { stopped = true; }; }, []);
  const patch = (v: Partial<ReviewInput>) => setInput(x => ({ ...x, ...v }));
  return <div className="flex-1 overflow-auto p-6"><form className="mx-auto max-w-3xl space-y-6" onSubmit={e => { e.preventDefault(); void onCreate(input); }}>
    <div><h2 className="text-xl font-semibold">새 심사 세션</h2><p className="mt-2 text-sm text-muted-foreground">선택한 원고·표·그림·참고문헌과 심사의견을 GPT와 Claude 구독 연결로 전송합니다. 시작하면 별도 작업본의 본문·표 자동 수정을 허용합니다.</p></div>
    <div className="grid grid-cols-2 gap-3">{([ ["virtual", "가상 심사", "관점을 나눈 GPT 리뷰 후 Claude가 통합 수정합니다."], ["peer", "실제 심사 대응", "실제 심사자의 원문을 보존하며 답변과 원고를 준비합니다."] ] as const).map(([mode, title, description]) => <button type="button" key={mode} onClick={() => patch({ mode })} className={`rounded-xl border p-4 text-left ${input.mode === mode ? "border-primary bg-primary/5" : "border-border"}`}><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p></button>)}</div>
    <fieldset><legend className="mb-2 text-sm font-semibold">원고 범위 · 목록 순서로 검토</legend><div className="mb-2 flex gap-2"><button type="button" className={button} onClick={() => patch({ documents: [...names] })}>모두 선택</button><button type="button" className={button} onClick={() => patch({ documents: [] })}>모두 해제</button><span className="self-center text-xs text-muted-foreground">{input.documents.length}/{names.length}개 선택</span></div><div className="max-h-40 space-y-2 overflow-auto rounded-lg border border-border p-3">{names.map(name => <label key={name} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={input.documents.includes(name)} onChange={e => patch({ documents: e.target.checked ? names.filter(n => n === name || input.documents.includes(n)) : input.documents.filter(n => n !== name) })} />{name}</label>)}</div></fieldset>
    {input.mode === "peer" && <label className="block text-sm font-semibold">실제 제출본 확인<textarea className={`${field} mt-2`} value={input.baselineNote} onChange={e => patch({ baselineNote: e.target.value })} placeholder="이 원고가 심사자가 검토한 제출본인지 기록하세요. 이후 수정본이면 차이와 위치 매칭 한계를 적어 주세요." /></label>}
    <div><p className="mb-2 text-xs text-muted-foreground">{connection}</p><div className="grid grid-cols-2 gap-4"><label className="text-sm">GPT 심사 모델<select required className={`${field} mt-2`} value={input.reviewerModel} onChange={e => patch({ reviewerModel: e.target.value })}><option value="">모델 선택</option>{models.codex.map(m => <option key={m}>{m}</option>)}</select></label><label className="text-sm">Claude 수정 모델<select required className={`${field} mt-2`} value={input.reviserModel} onChange={e => patch({ reviserModel: e.target.value })}><option value="">모델 선택</option>{models.claude.map(m => <option key={m}>{m}</option>)}</select></label></div></div>
    <div className="grid grid-cols-2 gap-4"><label className="text-sm">최대 수정 회차<select className={`${field} mt-2`} value={input.maxCycles} onChange={e => patch({ maxCycles: Number(e.target.value) as 1 | 2 })}><option value={2}>최대 2회 · 해결되면 조기 종료</option><option value={1}>1회</option></select></label><label className="text-sm">답변서 언어<select className={`${field} mt-2`} value={input.language} onChange={e => patch({ language: e.target.value })}><option value="English">영어 (English)</option><option value="Korean">한국어</option></select></label></div>
    <fieldset className="space-y-3"><legend className="mb-2 text-sm font-semibold">심사자 {input.mode === "virtual" ? "관점" : "원문 의견"}</legend>{input.reviewers.map((r, index) => <div key={r.id} className="space-y-2 rounded-xl border border-border p-4"><div className="flex items-center gap-2"><label className="flex-1"><span className="text-xs text-muted-foreground">{r.id} · 표시명</span><input className={field} value={r.name} onChange={e => patch({ reviewers: input.reviewers.map((v, i) => i === index ? { ...v, name: e.target.value } : v) })} /></label>{input.reviewers.length > 1 && <button type="button" className={button} aria-label={`Remove ${r.id}`} onClick={() => patch({ reviewers: input.reviewers.filter((_, i) => i !== index).map((r, i) => ({ ...r, id: `R${i + 1}` })) })}><X size={13} /></button>}</div>{input.mode === "virtual" ? <label className="block text-xs">관점<input className={`${field} mt-1`} value={r.focus} onChange={e => patch({ reviewers: input.reviewers.map((v, i) => i === index ? { ...v, focus: e.target.value } : v) })} /></label> : <><textarea required rows={5} className={field} aria-label={`${r.name} original review`} value={r.original} onChange={e => patch({ reviewers: input.reviewers.map((v, i) => i === index ? { ...v, original: e.target.value } : v) })} placeholder="전체 심사의견을 그대로 붙여 넣으세요. 하위 질문을 포함한 원문을 보존합니다." /><label className="text-xs text-primary">TXT/Markdown 가져오기<input type="file" className="mt-1 block text-xs" accept=".txt,.md,text/plain,text/markdown" onChange={async e => { const file = e.target.files?.[0]; if (file) { const original = await file.text(); setInput(current => ({ ...current, reviewers: current.reviewers.map(v => v.id === r.id ? { ...v, original } : v) })); } }} /></label></>}</div>)}<button type="button" disabled={input.reviewers.length >= 8} className={button} onClick={() => patch({ reviewers: [...input.reviewers, { id: `R${input.reviewers.length + 1}`, name: `Reviewer ${input.reviewers.length + 1}`, focus: "", original: "" }] })}><Plus size={13} />심사자 추가</button><p className="text-xs text-muted-foreground">가상 심사는 같은 GPT에 서로 다른 관점을 부여합니다. 독립적인 실제 전문가를 대체하지 않습니다.</p></fieldset>
    {input.mode === "peer" && <label className="block text-sm">편집자 결정문<textarea rows={4} className={`${field} mt-2`} value={input.decisionLetter} onChange={e => patch({ decisionLetter: e.target.value })} /></label>}
    <label className="block text-sm">유지할 연구 사실·저자 결정<textarea rows={3} className={`${field} mt-2`} value={input.authorConstraints} onChange={e => patch({ authorConstraints: e.target.value })} placeholder="변경하면 안 되는 설계, 용어, 관점 등을 적어 주세요." /></label>
    <div className="rounded-xl bg-accent/50 p-4 text-xs leading-6 text-muted-foreground">완료 후 편집: 프로젝트/revisions/세션/documents<br />원본 documents와 내부 검토 기록은 보존합니다. 그림 파일 교체는 승인 후에만 가능합니다. 모든 입력의 전체 검토가 불가능하면 미검토 상태를 표시합니다. 구독 인증·한도 오류 시 해당 단계에서 중지합니다.</div>
    <div className="flex justify-end gap-2 pb-4"><button type="button" className={button} onClick={onCancel}>돌아가기</button><button className={primary} disabled={busy || !input.documents.length || !input.reviewerModel || !input.reviserModel}>{busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}원본 고정 · 세션 만들기</button></div>
  </form></div>;
}
function FigureCard({ address, approval, busy, sealed, onAction }: { address: ReviewAddress; approval: FigureApproval; busy: boolean; sealed: boolean; onAction: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [preview, setPreview] = useState(""); const [previewError, setPreviewError] = useState("");
  return <article className="space-y-3 rounded-xl border border-border p-4"><h3 className="break-all text-sm font-semibold">{approval.figureId} · {approval.round}차</h3><p className="text-xs text-muted-foreground">{approval.status === "imported" ? "대체 파일 등록 완료" : sealed ? "원본 유지 · 수정 미적용" : approval.status === "approved" ? "교체 허용됨 · 대체 파일 미등록" : approval.status === "kept" ? "현재 그림 유지 선택" : "원본 유지 · 저자 확인 필요"} · {approval.commentIds.join(", ")} · 원본 보존</p><p className="rounded-lg bg-accent/50 p-3 text-xs leading-5">{sealed ? "이 회차는 완료됐습니다. 미적용 그림 요청은 답변서에서 확인하고, 필요하면 별도 편집 사본에서 교체해 주세요." : "교체 허용만으로 새 그림이 생성되지는 않습니다. 준비한 대체 파일이 없으면 원본을 유지하며 검토를 계속합니다."}</p><p className="whitespace-pre-wrap text-sm leading-6">{approval.specification}</p><button className={button} onClick={async () => { try { setPreview(await rpc.reviewFigurePreview(address, approval.figureId, Math.max(0, approval.round - 1))); } catch (e) { setPreviewError(String(e)); } }}>현재 그림 보기</button>{preview && <img src={preview} alt={approval.figureId} className="max-h-72 max-w-full rounded-lg border border-border object-contain" />}{previewError && <p className="text-xs text-muted-foreground">{previewError}</p>}{!sealed && <div className="flex flex-wrap gap-2">{approval.status !== "imported" && <><button disabled={busy} className={primary} onClick={() => onAction(() => rpc.reviewDecideFigure(address, approval.id, "approved"))}>대체 파일 교체 허용</button><button disabled={busy} className={button} onClick={() => onAction(() => rpc.reviewDecideFigure(address, approval.id, "kept"))}>현재 그림 유지</button><button disabled={busy} className={button} onClick={() => onAction(() => rpc.reviewDecideFigure(address, approval.id, "deferred"))}>보류</button></>}{approval.status === "approved" && <button disabled={busy} className={primary} onClick={() => onAction(() => rpc.reviewImportFigure(address, approval.id))}>준비한 대체 그림 파일 선택</button>}</div>}</article>;
}
function ManuscriptPreview({ address, session }: { address: ReviewAddress; session: ReviewSession }) {
  const [round, setRound] = useState(0); const [text, setText] = useState(""); const [error, setError] = useState("");
  useEffect(() => { let stopped = false; setError(""); void rpc.reviewManuscript(address, round).then(v => { if (!stopped) setText(v); }).catch(e => { if (!stopped) setError(String(e)); }); return () => { stopped = true; }; }, [address.projectPath, address.sessionId, round]);
  return <div className="p-5"><label className="text-sm">읽기 전용 원고<select className={`${field} my-3 max-w-xs block`} value={round} onChange={e => setRound(Number(e.target.value))}><option value={0}>원본</option>{session.rounds.map(r => <option key={r.round} value={r.round}>{r.round}차 결과{r.round === session.selectedFinalRound ? " · 최종 후보" : ""}</option>)}</select></label><p className="mb-4 text-xs text-muted-foreground">전체 본문·표·인용을 표시합니다. 원본과 봉인된 결과는 여기서 수정할 수 없습니다.</p>{error ? <p role="alert">{error}</p> : <ReadOnlyManuscript text={text} address={address} round={round} />}</div>;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function Inline({ value }: { value: unknown }): React.ReactNode {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v, i) => <Inline key={i} value={v} />);
  const v = record(value); const props = record(v.props);
  if (v.type === "text") return <span style={{ fontWeight: record(v.styles).bold ? 600 : undefined, fontStyle: record(v.styles).italic ? "italic" : undefined }}>{String(v.text ?? "")}</span>;
  if (v.type === "citation") return <span className="rounded bg-amber-500/10 px-1 text-amber-800">[@{String(props.citekey ?? props.citeKey ?? "citation")}]</span>;
  if (v.type === "footnote") return <span className="text-muted-foreground">[{String(props.text ?? props.content ?? "footnote")}]</span>;
  if (v.type === "math" || v.type === "inlineMath") return <code>{String(props.latex ?? props.formula ?? "")}</code>;
  if (v.content) return <Inline value={v.content} />;
  return <span className="text-muted-foreground">{String(props.label ?? props.target ?? v.type ?? "")}</span>;
}
export function ReadOnlyManuscript({ text, address, round, changedBlocks = [] }: { text: string; address: ReviewAddress; round: number; changedBlocks?: string[] }) {
  let documents: Record<string, unknown> = {}; try { documents = record(JSON.parse(text)); } catch { return <p className="text-sm text-muted-foreground">원고를 읽는 중…</p>; }
  const render = (blocks: unknown[], filename: string): React.ReactNode => blocks.map((value, index) => {
    const b = record(value); const p = record(b.props); const content = <Inline value={b.content} />;
    let body: React.ReactNode;
    if (b.type === "heading") body = <h3 className={`mb-3 mt-6 font-semibold ${p.level === 1 ? "text-xl" : "text-lg"}`}>{content}</h3>;
    else if (b.type === "table") body = <div className="my-5 overflow-x-auto"><p className="mb-2 text-sm font-medium">{String(p.caption ?? "")}</p><table className="w-full border-collapse text-sm"><tbody>{(Array.isArray(record(b.content).rows) ? record(b.content).rows as unknown[] : []).map((row, i) => <tr key={i}>{(Array.isArray(record(row).cells) ? record(row).cells as unknown[] : []).map((cell, j) => <td key={j} colSpan={Number(record(record(cell).props).colspan ?? 1)} className={`border border-border px-3 py-2 ${i === 0 ? "bg-accent font-medium" : ""}`}><Inline value={cell} /></td>)}</tr>)}</tbody></table></div>;
    else if (b.type === "figure" || b.type === "image") body = <ManuscriptFigure address={address} figureId={`${filename}#${String(b.id)}`} round={round} caption={String(p.caption ?? "")} />;
    else if (b.type === "math") body = <pre className="my-4 overflow-auto rounded-lg bg-accent p-4">{String(p.latex ?? p.formula ?? "")}</pre>;
    else body = <p className="my-3 whitespace-pre-wrap text-sm leading-7">{content}</p>;
    return <div key={String(b.id ?? index)} data-original-block={String(b.id ?? index)} className={changedBlocks.includes(String(b.id)) ? "border-l-2 border-amber-500 bg-amber-500/5 pl-3" : ""}>{body}{Array.isArray(b.children) && b.children.length > 0 && <div className="ml-5 border-l border-border pl-4">{render(b.children, filename)}</div>}</div>;
  });
  return <div className="mx-auto max-w-3xl">{Object.entries(documents).map(([filename, blocks]) => <article key={filename} className="mb-8 rounded-xl border border-border bg-background p-6"><h2 className="mb-5 border-b border-border pb-3 text-sm font-semibold text-muted-foreground">{filename.replace(/\.scholarpen\.json$/, "")}</h2>{Array.isArray(blocks) && render(blocks, filename)}</article>)}</div>;
}
function ManuscriptFigure({ address, figureId, round, caption }: { address: ReviewAddress; figureId: string; round: number; caption: string }) {
  const [url, setUrl] = useState(""); const [error, setError] = useState("");
  useEffect(() => { let stopped = false; setUrl(""); setError(""); void rpc.reviewFigurePreview(address, figureId, round).then(v => { if (!stopped) setUrl(v); }).catch(e => { if (!stopped) setError(String(e)); }); return () => { stopped = true; }; }, [address.projectPath, address.sessionId, figureId, round]);
  return <figure className="my-5">{url ? <img src={url} alt={caption} className="mx-auto max-h-96 max-w-full object-contain" /> : <p className="rounded-lg bg-accent p-3 text-xs text-muted-foreground">{error || "그림을 읽는 중…"}</p>}<figcaption className="mt-2 text-center text-sm text-muted-foreground">{caption}</figcaption></figure>;
}
