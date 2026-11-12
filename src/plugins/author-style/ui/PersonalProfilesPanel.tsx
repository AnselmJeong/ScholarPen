import React, { useEffect, useState } from "react";
import type { PersonalStyleLibrary, StyleOperation, StyleRule } from "../../../shared/author-style";
import { styleCommand, STYLE_CHANGED } from "../client";
import { registerExtensionGuard } from "../../../renderer/extensions/state";
import { RuleEditor } from "./AuthorLearningPanel";
const field = "w-full rounded border border-border bg-background px-2 py-1.5 text-xs";
const button = "rounded border border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50";
export function PersonalProfilesPanel() {
  const [library, setLibrary] = useState<PersonalStyleLibrary | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [id, setId] = useState(""), [name, setName] = useState(""), [language, setLanguage] = useState("ko"), [genre, setGenre] = useState("academic");
  const [rule, setRule] = useState(""), [confirmDelete, setConfirmDelete] = useState(false);
  const p = library?.profiles.find(p => p.id === id) ?? library?.profiles[0];
  useEffect(() => {
    let active = true, generation = 0;
    const refresh = () => { const current = ++generation; void styleCommand<PersonalStyleLibrary>({ scope: "personal", projectPath: "", operation: "view" }).then(v => { if (active && current === generation) setLibrary(v); }).catch(e => { if (active) setError(String(e)); }); };
    refresh(); window.addEventListener(STYLE_CHANGED, refresh); return () => { active = false; window.removeEventListener(STYLE_CHANGED, refresh); };
  }, []);
  useEffect(() => registerExtensionGuard("scholarpen.author-style", () => { if (busy || rule || name) throw new Error("개인 프로필의 입력을 저장하거나 지운 뒤 비활성화하세요."); }), [busy, rule, name]);
  const run = async (operation: StyleOperation, payload?: unknown) => {
    if (!library) return; setBusy(true); setError("");
    try { const result = await styleCommand<PersonalStyleLibrary>({ scope: "personal", projectPath: "", operation, expectedRevision: library.revision, profileId: p?.id, payload }); setLibrary(result); return result; }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const saveRules = (rules: StyleRule[], profileName = p!.name) => run("update", { name: profileName, rules });
  return <section aria-label="개인 전역 문체 프로필" className="space-y-3 rounded border border-border p-4 text-xs">
    <h3 className="text-sm font-medium">개인 전역 문체 프로필</h3>
    <p className="leading-5 text-muted-foreground">여러 프로젝트에서 쓸 규칙을 직접 관리합니다. 프로젝트 지정이 우선하며, 지정이 없으면 언어·장르 기본 → 개인 기본 순서로 선택합니다. 언어가 맞지 않는 프로필은 적용하지 않습니다.</p>
    {error && <p role="alert" className="text-amber-700">{error}</p>}
    {library && <fieldset disabled={busy} className="min-w-0 space-y-3">
      <select aria-label="개인 프로필 선택" className={field} value={p?.id ?? ""} onChange={e => { setId(e.target.value); setRule(""); setConfirmDelete(false); }}>
        {!p && <option value="">개인 프로필 없음</option>}{library.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.language}/{p.genre}</option>)}
      </select>
      <details><summary className="cursor-pointer">개인 프로필 만들기</summary><div className="mt-2 space-y-2">
        <input className={field} aria-label="새 개인 프로필 이름" placeholder="예: 나의 학술문 기본" value={name} maxLength={100} onChange={e => setName(e.target.value)} />
        <div className="flex gap-2"><select aria-label="개인 프로필 언어" className={field} value={language} onChange={e => setLanguage(e.target.value)}><option value="ko">한국어</option><option value="en">영어</option><option value="any">모든 언어</option></select>
          <select aria-label="개인 프로필 장르" className={field} value={genre} onChange={e => setGenre(e.target.value)}><option value="academic">학술문</option><option value="explanation">설명문</option><option value="any">모든 장르</option></select></div>
        <button className={button} disabled={!name.trim()} onClick={() => void run("create", { name, language, genre }).then(v => { if (v) { setId(v.profiles.at(-1)!.id); setName(""); } })}>개인 프로필 생성</button>
      </div></details>
      <label className="block space-y-1"><span>개인 기본 (언어·장르 기본이 없을 때)</span><select aria-label="개인 전역 기본 프로필" className={field} value={library.defaultProfileId ?? ""} onChange={e => void run("setDefaults", { defaultProfileId: e.target.value || null, defaults: library.defaults })}>
        <option value="">사용 안 함</option>{library.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      {p && <>
        <div className="flex flex-wrap items-center gap-2"><span>{p.language}/{p.genre} · 버전 {p.revision}</span><button className={button} onClick={() => void run("setDefaults", { defaultProfileId: library.defaultProfileId,
          defaults: [...library.defaults.filter(d => d.language !== p.language || d.genre !== p.genre), { language: p.language, genre: p.genre, profileId: p.id }] })}>이 언어·장르의 기본으로 설정</button></div>
        {p.rules.map(r => <RuleEditor key={`${r.id}:${p.revision}`} rule={r} evidence={[]} save={next => void saveRules(p.rules.map(item => item.id === next.id ? next : item))} />)}
        <textarea aria-label="개인 문체 규칙" className={field} value={rule} maxLength={500} placeholder="여러 프로젝트에 적용할 명시적 규칙" onChange={e => setRule(e.target.value)} />
        <button className={button} disabled={!rule.trim()} onClick={() => void saveRules([...p.rules, { id: crypto.randomUUID(), instruction: rule, language: p.language, genre: p.genre, evidenceIds: [], source: "explicit", status: "active", support: "author-confirmed" }]).then(v => { if (v) setRule(""); })}>개인 규칙 추가</button>
        <details><summary className="cursor-pointer">개인 프로필 이름·버전·삭제</summary><div className="mt-2 space-y-2">
          <form key={`${p.id}:${p.name}`} onSubmit={e => { e.preventDefault(); void saveRules(p.rules, String(new FormData(e.currentTarget).get("name"))); }}><input className={field} aria-label="개인 프로필 이름 변경" name="name" defaultValue={p.name} maxLength={100} /><button className={`${button} mt-1`}>이름 저장</button></form>
          {library.history.filter(h => h.id === p.id).slice(-5).reverse().map(h => <button className={`${button} mr-1`} key={h.revision} onClick={() => void run("restore", { revision: h.revision })}>버전 {h.revision} 복원</button>)}
          <label className="flex gap-2"><input type="checkbox" checked={confirmDelete} onChange={e => setConfirmDelete(e.target.checked)} />개인 프로필을 삭제하고 이 프로필의 기본 설정을 해제합니다.</label>
          <button className={button} disabled={!confirmDelete} onClick={() => void run("delete").then(v => { if (v) { setId(""); setConfirmDelete(false); } })}>개인 프로필 삭제</button>
        </div></details>
      </>}
      {!!library.defaults.length && <div className="space-y-2"><p className="font-medium">언어·장르 기본</p>{library.defaults.map(d => <div key={`${d.language}:${d.genre}`} className="flex flex-wrap items-center justify-between gap-2"><span>{d.language}/{d.genre} → {library.profiles.find(p => p.id === d.profileId)?.name}</span><button className={button} onClick={() => void run("setDefaults", { defaultProfileId: library.defaultProfileId, defaults: library.defaults.filter(item => item !== d) })}>기본 연결 해제</button></div>)}</div>}
      <p className="text-muted-foreground">개인 프로필은 승인한 규칙만 공유합니다. 프로젝트의 샘플·근거·자동 학습은 이곳에 합쳐지지 않습니다. 개인 규칙을 수정하면 연결된 프로젝트의 다음 요청부터 적용됩니다.</p>
    </fieldset>}
  </section>;
}
