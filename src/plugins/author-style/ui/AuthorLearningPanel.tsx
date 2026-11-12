import React, { useEffect, useRef, useState } from "react";
import { Brain, Plus, RefreshCw, Trash2 } from "lucide-react";
import { rpc } from "../../../renderer/rpc";
import { registerExtensionGuard } from "../../../renderer/extensions/state";
import { styleCommand, STYLE_CHANGED } from "../client";
import type { StyleComparison, StyleConfig, StyleOperation, StyleRule, StyleView } from "../../../shared/author-style";

const field = "w-full rounded border border-border bg-background px-2 py-1.5 text-xs";
const button = "rounded border border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50";
export function useStyleView(projectPath: string) {
  const [view, setView] = useState<StyleView | null>(null), [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current; let active = true;
    const refresh = () => { if (projectPath) void styleCommand({ projectPath, operation: "view" }).then(v => {
      if (active && current === generation.current) { setView(v); setError(""); }
    }).catch(e => { if (active) setError(String(e)); }); };
    setView(null); setError(""); refresh(); window.addEventListener(STYLE_CHANGED, refresh);
    return () => { active = false; ++generation.current; window.removeEventListener(STYLE_CHANGED, refresh); };
  }, [projectPath]);
  return { view, setView, error, setError };
}

export function AuthorLearningPanel({ projectPath }: { projectPath: string }) {
  const { view, setView, error, setError } = useStyleView(projectPath);
  const [selected, setSelected] = useState(""), [name, setName] = useState(""), [language, setLanguage] = useState("ko"), [genre, setGenre] = useState("academic");
  const [rule, setRule] = useState(""), [sample, setSample] = useState(""), [sampleName, setSampleName] = useState(""), [ownWriting, setOwnWriting] = useState(false);
  const [comparisonInput, setComparisonInput] = useState(""), [comparison, setComparison] = useState<StyleComparison | null>(null);
  const [busy, setBusy] = useState(""), [requestId, setRequestId] = useState("");
  const [packageText, setPackageText] = useState(""), [includeSamples, setIncludeSamples] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const currentPath = useRef(projectPath); currentPath.current = projectPath;
  const p = view?.profiles.find(p => p.id === selected) ?? view?.profiles.find(p => p.id === view.activeProfileId) ?? view?.profiles[0];
  const evidence = view?.evidence.filter(e => e.profileId === p?.id) ?? [];
  useEffect(() => { setSelected(""); setRule(""); setSample(""); setComparison(null); setPackageText(""); }, [projectPath]);
  useEffect(() => registerExtensionGuard("scholarpen.author-style", () => { if (busy || sample || rule) throw new Error("문체 프로필의 작업을 완료하거나 입력 중인 규칙·샘플을 지운 뒤 비활성화하세요."); }), [busy, sample, rule]);
  const run = async <T,>(operation: StyleOperation, payload?: unknown, profileId = p?.id): Promise<T | undefined> => {
    if (!view) return;
    const path = projectPath, id = crypto.randomUUID(); setRequestId(id); setBusy(operation); setError("");
    try {
      const result = await styleCommand<T>({ projectPath: path, operation, expectedRevision: view.revision, ...(profileId ? { profileId } : {}), ...(payload ? { payload } : {}) }, id);
      if (currentPath.current !== path) return;
      if (result && typeof result === "object" && "profiles" in result) setView(result as unknown as StyleView);
      return result;
    } catch (e) { if (currentPath.current === path) setError(String(e)); }
    finally { if (currentPath.current === path) { setBusy(""); setRequestId(""); } }
  };
  const configure = (patch: Partial<StyleConfig>) => void run("configure", { ...view!.config, ...patch });
  const saveRules = (rules: StyleRule[], profileName = p!.name) => run("update", { name: profileName, rules });
  if (!projectPath) return <p className="p-3 text-xs text-muted-foreground">프로젝트를 열면 내 문체 프로필을 관리할 수 있습니다.</p>;
  return <section className="space-y-3 border-b border-border p-3 text-xs" aria-label="내 문체 프로필">
    <div className="flex items-center gap-2 font-medium"><Brain className="h-4 w-4" />내 문체
      <button aria-label="문체 새로고침" className="ml-auto" onClick={() => void run("view")}><RefreshCw className="h-3.5 w-3.5" /></button>
    </div>
    <p className="leading-5 text-muted-foreground">본인이 쓴 글과 직접 편집한 근거로 문체 규칙을 만듭니다. 프로필은 프로젝트 지정 또는 선택한 개인 기본 규칙을 적용하며 원고는 자동으로 바뀌지 않습니다.</p>
    {error && <p role="alert" className="break-words text-amber-700 dark:text-amber-300">{error}</p>}
    {view?.remoteDeletionPending && <p role="status" className="text-amber-700">이전에 Hindsight로 전송한 학습 자료의 삭제가 대기 중입니다. 삭제 완료 전까지 원격 기억 주입을 중단합니다. 프로젝트를 열어 두면 재시도합니다.</p>}
    {view && <fieldset disabled={!!busy} className="min-w-0 space-y-3 disabled:opacity-70">
      {view.migration && <p className="rounded bg-muted p-2">기존 프로젝트 편집 취향을 이전했습니다. 원본과 백업은 보존되어 있습니다.</p>}
      <div className="flex gap-2"><select aria-label="문체 프로필 선택" className={field} value={p?.id ?? ""} onChange={e => { setSelected(e.target.value); setDeleteConfirm(false); setComparison(null); }}>
        {!p && <option value="">프로필 없음</option>}{view.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.language}/{profile.genre}</option>)}
      </select>{p && <button className={button} onClick={() => void run("select")}>{p.id === view.activeProfileId ? "적용 중" : "적용"}</button>}</div>
      <label className="block space-y-1"><span>이 프로젝트에 적용할 문체</span><select aria-label="프로젝트 문체 연결" className={field} value={view.activeProfileId ? `project:${view.activeProfileId}` : view.personalProfileId ? `personal:${view.personalProfileId}` : "auto"} onChange={e => {
        const value = e.target.value;
        if (value === "auto") void run("useDefaults");
        else if (value.startsWith("personal:")) void run("linkPersonal", { id: value.slice(9) });
        else void run("select", undefined, value.slice(8));
      }}><option value="auto">개인 기본 자동 선택 (언어·장르별)</option>
        {view.profiles.map(item => <option key={item.id} value={`project:${item.id}`}>프로젝트: {item.name}</option>)}
        {view.personal?.profiles.map(item => <option key={item.id} value={`personal:${item.id}`}>개인: {item.name}</option>)}
        {view.personalProfileId && !view.personal?.profiles.some(item => item.id === view.personalProfileId) && <option value={`personal:${view.personalProfileId}`}>삭제된 개인 프로필 · 다시 선택하세요</option>}
      </select></label>
      <details><summary className="cursor-pointer">새 프로필 만들기</summary><div className="mt-2 space-y-2">
        <input aria-label="새 프로필 이름" placeholder="예: 한국어 학술문" className={field} value={name} onChange={e => setName(e.target.value)} />
        <div className="flex gap-2"><select aria-label="프로필 언어" className={field} value={language} onChange={e => setLanguage(e.target.value)}><option value="ko">한국어</option><option value="en">영어</option><option value="any">모든 언어</option></select>
        <select aria-label="프로필 장르" className={field} value={genre} onChange={e => setGenre(e.target.value)}><option value="academic">학술문</option><option value="explanation">설명문</option><option value="any">모든 장르</option></select></div>
        <button className={button} disabled={!name.trim()} onClick={() => void run<StyleView>("create", { name, language, genre }).then(v => { if (v) { setSelected(v.profiles.at(-1)!.id); setName(""); } })}>프로필 만들기</button>
      </div></details>
      <div className="space-y-2 rounded border border-border p-2">
        <label className="flex items-center justify-between gap-2">프로젝트 글 유형<select aria-label="프로젝트 글 유형" className="rounded bg-background p-1" value={view.config.genre ?? "academic"} onChange={e => configure({ genre: e.target.value as StyleConfig["genre"] })}><option value="academic">학술문</option><option value="explanation">설명문</option><option value="any">공통</option></select></label>
        <label className="flex items-center justify-between gap-2">적용 강도<select aria-label="문체 적용 강도" className="rounded bg-background p-1" value={view.config.strength} onChange={e => configure({ strength: e.target.value as StyleConfig["strength"] })}><option value="off">끄기</option><option value="light">약하게</option><option value="normal">보통</option><option value="strong">강하게</option></select></label>
        {([
          ["observe", "편집에서 배우기 (직접 입력만 로컬 보관)"], ["autoAnalyze", "유휴 시 자동 분석 (관찰 10건·유휴 5분 이상)"],
          ["autoApprove", "반복 편집 근거가 있는 규칙 자동 승인"], ["applyToChat", "일반 AI 대화에도 적용"], ["localOnly", "분석은 로컬 모델만 사용"],
        ] as const).map(([key, label]) => <label key={key} className="flex items-start gap-2"><input type="checkbox" checked={view.config[key]} onChange={e => configure({ [key]: e.target.checked })} />{label}</label>)}
        <p className="break-words text-muted-foreground">분석 공급자: {view.provider} · {view.localProvider ? "로컬" : "원격"}</p>
        {!view.config.localOnly && <label className="flex items-start gap-2"><input type="checkbox" checked={view.config.remoteConsent} onChange={e => configure({ remoteConsent: e.target.checked })} />분석·비교 시 선택한 샘플과 수정 쌍을 위 공급자에게 전송하는 데 동의합니다.</label>}
        <p className="text-muted-foreground">문체 적용 시 승인 규칙은 작성 요청의 AI 공급자에게 전달됩니다. 샘플 원문은 작성 요청에 포함하지 않습니다.</p>
      </div>
      {p && <>
        <button className={button} disabled={!view.personal || !p.rules.some(r => r.status === "active")} onClick={() => void run("publishPersonal", { name: `${p.name} (개인)`, personalRevision: view.personal!.revision, confirmRulesOnly: true })}>승인 규칙만 개인 프로필로 복사</button>
        <p className="text-muted-foreground">샘플 원문과 근거는 복사하지 않습니다. 복사 후 설정에서 개인 기본으로 지정하세요.</p>
        <p className="text-muted-foreground">{p.name} · 버전 {p.revision} · 근거 {evidence.length}건</p>
        <div className="space-y-2">{p.rules.map(r => <RuleEditor key={`${r.id}:${p.revision}`} rule={r} evidence={evidence.filter(e => r.evidenceIds.includes(e.id))} save={next => void saveRules(p.rules.map(item => item.id === r.id ? next : item))} />)}</div>
        {!p.rules.length && <p className="text-muted-foreground">아직 규칙이 없습니다. 직접 규칙을 추가하거나 내 글을 분석하세요.</p>}
        <div className="flex gap-2"><textarea aria-label="직접 작성한 문체 규칙" className={field} placeholder="예: 근거가 제한적이면 단정을 피한다" value={rule} onChange={e => setRule(e.target.value)} maxLength={500} />
        <button aria-label="문체 규칙 추가" className={button} disabled={!rule.trim()} onClick={() => void saveRules([...p.rules, { id: crypto.randomUUID(), instruction: rule, language: p.language, genre: p.genre, evidenceIds: [], source: "explicit", status: "active", support: "author-confirmed" }]).then(v => { if (v) setRule(""); })}><Plus className="h-4 w-4" /></button></div>
        <details><summary className="cursor-pointer">내 글 추가 · 근거 관리</summary><div className="mt-2 space-y-2">
          <p className="leading-5 text-muted-foreground">TXT·Markdown·Quarto 파일 또는 본인이 쓴 구간만 붙여 넣으세요. 공동저자·AI 생성 구간과 인용문을 지운 뒤 등록하세요. 코드·인용 블록·참고문헌은 자동 제외됩니다.</p>
          <input aria-label="내 글 파일 선택" type="file" accept=".txt,.md,.qmd" onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 240_000) { setError("샘플 파일은 240 KB 이하로 선택하세요."); return; } void file.text().then(text => { setSample(text.slice(0, 60000)); setSampleName(file.name); }); e.target.value = ""; }} />
          <input aria-label="샘플 이름" className={field} placeholder="샘플 이름" value={sampleName} onChange={e => setSampleName(e.target.value)} />
          <textarea aria-label="문체 샘플 본문" className={field} rows={6} value={sample} maxLength={60000} onChange={e => setSample(e.target.value)} />
          <label className="flex gap-2"><input type="checkbox" checked={ownWriting} onChange={e => setOwnWriting(e.target.checked)} />선택한 구간은 본인이 썼으며 분석에 사용할 수 있습니다.</label>
          <button className={button} disabled={!ownWriting || !sampleName || sample.length < 40} onClick={() => void run("addSample", { text: sample, label: sampleName, ownWriting }).then(v => { if (v) { setSample(""); setSampleName(""); setOwnWriting(false); } })}>샘플 등록</button>
          {evidence.map(e => <details key={e.id} className="rounded border border-border p-2"><summary className="cursor-pointer break-words">{e.label} · {e.kind === "author-sample" ? "본인 글" : e.kind === "accepted" ? "제안 수락 (약한 근거)" : e.kind === "rejected" ? "제안 거절" : "직접 편집"}</summary><p className="my-2 max-h-40 overflow-auto whitespace-pre-wrap">{e.observation ? `${e.observation.before}\n→ ${e.observation.after}` : e.text}</p><button className={button} onClick={() => void run("forgetEvidence", { id: e.id })}>근거와 파생 규칙 삭제</button></details>)}
          <p className="text-muted-foreground">학습 근거 삭제는 원고·문서 변경 이력을 지우지 않습니다. 개인 근거는 Hindsight에 전송하지 않습니다.</p>
        </div></details>
        <button className={button} disabled={!evidence.length} onClick={() => void run("analyze")}>지금 분석 · 후보 규칙 만들기</button>
        {error && <p role="alert" className="text-amber-700">{error}</p>}
        {view.error && <p className="text-amber-700">최근 분석: {view.error}</p>}
        <details><summary className="cursor-pointer">적용 전후 비교 (원고 변경 없음)</summary><div className="mt-2 space-y-2"><p className="text-muted-foreground">학습에 사용하지 않은 글로 비교하세요. 실제 문체 적합성과 의미 보존은 직접 판단해 주세요.</p>
          <textarea aria-label="문체 비교 입력" rows={4} className={field} value={comparisonInput} onChange={e => setComparisonInput(e.target.value)} />
          <button className={button} disabled={!comparisonInput.trim()} onClick={() => void run<StyleComparison>("compare", { text: comparisonInput }).then(v => { if (v) setComparison(v); })}>두 결과 비교</button>
          {comparison && <><p>프로필 버전 {comparison.profileRevision} · 적용 규칙 {comparison.application?.ruleIds.length ?? 0}개</p><p className="font-medium">기본 작성</p><p className="whitespace-pre-wrap rounded bg-muted p-2">{comparison.baseline}</p><p className="font-medium">내 문체 적용</p><p className="whitespace-pre-wrap rounded bg-muted p-2">{comparison.styled}</p>{comparison.warnings.map(w => <p key={w} role="alert" className="text-amber-700">{w}</p>)}</>}
        </div></details>
        <details><summary className="cursor-pointer">이름 변경 · 버전 복원 · 삭제</summary><div className="mt-2 space-y-2">
          <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void saveRules(p.rules, String(data.get("profileName"))); }} key={p.id}><input className={field} name="profileName" aria-label="프로필 이름 변경" defaultValue={p.name} maxLength={100} /><button className={`${button} mt-2`}>이름 저장</button></form>
          {view.history.filter(h => h.id === p.id).slice(-5).reverse().map(h => <button key={h.revision} className={`${button} mr-1`} onClick={() => void run("restore", { revision: h.revision })}>버전 {h.revision} 복원</button>)}
          <label className="flex gap-2"><input type="checkbox" checked={deleteConfirm} onChange={e => setDeleteConfirm(e.target.checked)} />이 프로필과 학습 근거를 삭제합니다.</label><button disabled={!deleteConfirm} className={button} onClick={() => void run("delete").then(() => { setSelected(""); setDeleteConfirm(false); })}>프로필 삭제</button>
        </div></details>
      </>}
      <details><summary className="cursor-pointer">프로젝트 간 가져오기 · 내보내기</summary><div className="mt-2 space-y-2">
        <label className="flex gap-2"><input type="checkbox" checked={includeSamples} onChange={e => setIncludeSamples(e.target.checked)} />내보내기에 샘플 원문 포함</label>
        <button disabled={!p} className={button} onClick={() => void run<{ package: string }>("export", { includeSamples }).then(v => { if (v) { setPackageText(v.package); const url = URL.createObjectURL(new Blob([v.package], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "author-style.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } })}>프로필 파일 내보내기</button>
        <input aria-label="문체 프로필 파일 가져오기" type="file" accept=".json" onChange={e => { const f = e.target.files?.[0]; if (f && f.size <= 500000) void f.text().then(setPackageText); e.target.value = ""; }} />
        <textarea aria-label="프로필 JSON" className={field} rows={4} value={packageText} onChange={e => setPackageText(e.target.value)} />
        <button disabled={!packageText.trim()} className={button} onClick={() => void run<StyleView>("import", { package: packageText }).then(v => { if (v) { setSelected(v.profiles.at(-1)!.id); setPackageText(""); } })}>이 프로젝트로 가져오기</button>
        <p className="text-muted-foreground">가져온 규칙은 후보로 표시됩니다. 검토 후 승인하면 적용됩니다.</p>
      </div></details>
      {!!view.applications.length && <details><summary className="cursor-pointer">최근 적용 내역</summary>{view.applications.slice(-5).reverse().map((a, i) => <p key={i} className="mt-1 text-muted-foreground">{new Date(a.at).toLocaleString()} · 버전 {a.profileRevision} · {a.purpose} · 규칙 {a.ruleIds.length}개 · {a.model}</p>)}</details>}
    </fieldset>}
    {busy && <div className="flex items-center gap-2" role="status">{busy === "analyze" ? "문체 분석 중…" : busy === "compare" ? "비교 생성 중…" : "저장 중…"}{["analyze", "compare"].includes(busy) && <button className={button} onClick={() => void rpc.extensionsCancel(requestId)}>취소</button>}</div>}
  </section>;
}
export function RuleEditor({ rule, evidence, save }: { rule: StyleRule; evidence: Array<{ id: string; label: string; text: string }>; save: (rule: StyleRule) => void }) {
  const [text, setText] = useState(rule.instruction);
  useEffect(() => registerExtensionGuard("scholarpen.author-style", () => { if (text !== rule.instruction) throw new Error("편집 중인 문체 규칙을 저장한 뒤 비활성화하세요."); }), [text, rule.instruction]);
  return <div className="space-y-2 rounded border border-border p-2"><textarea aria-label="문체 규칙 편집" className={field} value={text} maxLength={500} onChange={e => setText(e.target.value)} />
    <div className="flex flex-wrap items-center gap-2"><span className="text-muted-foreground">{rule.status === "active" ? "적용 중" : rule.status === "dismissed" ? "제외됨" : "후보"} · {rule.source === "explicit" ? "직접 작성" : rule.support === "repeated" ? "반복 근거" : rule.support === "author-confirmed" ? "저자 승인" : "승인 필요"}</span>
      <button className={button} disabled={!text.trim()} onClick={() => save({ ...rule, instruction: text, status: "active" })}>{text !== rule.instruction ? "수정·승인" : "승인"}</button>
      <button aria-label="문체 규칙 제외" className={button} onClick={() => save({ ...rule, status: "dismissed" })}><Trash2 className="h-3 w-3" /></button></div>
    {!!evidence.length && <details><summary className="cursor-pointer">근거 {evidence.length}건</summary>{evidence.map(e => <p key={e.id} className="mt-2 whitespace-pre-wrap">{e.label}: {e.text.slice(0, 1000)}</p>)}</details>}
  </div>;
}
