import React, { useEffect, useState } from "react";
import type { PunctuationPolicy, WritingPreferences } from "../../../shared/writing-preferences";
import { refreshWritingPreferences, saveWritingPreferences } from "../../extensions/writing-preferences";

/** Explicit author settings stay available even when Author Style is disabled. */
export function WritingPreferencesPanel() {
  const [view, setView] = useState<WritingPreferences | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void refreshWritingPreferences().then(v => { if (active) setView(v); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  const update = async (key: keyof PunctuationPolicy, value: PunctuationPolicy[typeof key]) => {
    if (!view) return; setBusy(true); setError("");
    try { setView(await saveWritingPreferences({ ...view, punctuation: { ...view.punctuation, [key]: value } })); }
    catch (e) { setError(String(e)); try { setView(await refreshWritingPreferences()); } catch { /* preserve the displayed error */ } }
    finally { setBusy(false); }
  };
  return <section aria-label="문장부호 정책" className="space-y-3 rounded border border-border p-4 text-sm">
    <h3 className="font-medium">문장부호 정책</h3>
    <p className="text-xs leading-5 text-muted-foreground">모든 프로젝트의 AI 작성 기본 설정입니다. 변경은 즉시 저장되며 Author Style을 꺼도 유지됩니다. 인용문·수식·코드·URL·인용 목록은 보존합니다.</p>
    {([ ["emDash", "Em dash (—)"], ["semicolon", "세미콜론 (;)" ] ] as const).map(([key, label]) => <label key={key} className="flex flex-wrap items-center justify-between gap-2">{label}
      <select aria-label={`${label} 정책`} className="rounded border border-border bg-background p-2 text-xs" disabled={!view || busy} value={view?.punctuation[key] ?? "avoid"} onChange={e => void update(key, e.target.value as PunctuationPolicy[typeof key])}>
        <option value="avoid">피하기 · 문장 다시 구성</option><option value="allow">허용 · 자동 제거 안 함</option>
      </select></label>)}
    <p className="text-xs text-muted-foreground">진행 중인 수정 제안은 요청 당시의 설정을 유지합니다. 기존 원고를 일괄 변경하지 않습니다.</p>
    {error && <p role="alert" className="text-xs text-amber-700">{error}</p>}
  </section>;
}
