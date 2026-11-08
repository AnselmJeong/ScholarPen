import React, { useSyncExternalStore } from 'react';
import type { RevisionContextState } from './RevisionContextPanel';
import type { ResponseDrafts } from './response-drafts';

export function RevisionResponseEditor({ state, projectPath, drafts }: { state: RevisionContextState; projectPath?: string; drafts: ResponseDrafts }) {
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const { data, error, loading } = state;
  if (loading) return <p role="status" className="p-4 text-sm">이 장의 답변서를 불러오는 중…</p>;
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
  if (!data || !projectPath) return <p className="p-4 text-sm text-muted-foreground">이 원고에 연결된 답변서가 없습니다.</p>;
  const render = (item: typeof data.comments[number]) => {
    const saved = data.editableResponses?.find(r => r.commentId === item.comment.id) ?? item.response;
    const key = drafts.key(projectPath, item.comment.id); const draft = drafts.get(key);
    const text = draft?.text ?? saved?.response ?? '';
    return <article key={item.comment.id} className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">{item.comment.reviewerId} · {item.comment.id}</h3>
      <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.comment.original}</p>
      <label className="block text-sm font-medium" htmlFor={`reply-${item.comment.id}`}>답변 편집</label>
      <textarea id={`reply-${item.comment.id}`} aria-label={`${item.comment.id} 답변 편집`} value={text} disabled={!saved}
        rows={Math.min(22, Math.max(8, Math.ceil(text.length / 65)))}
        className="w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-7 focus:outline-none focus:ring-2 focus:ring-primary"
        onChange={e => drafts.change({ projectPath, filename: data.filename, commentId: item.comment.id, response: e.target.value, expectedResponse: saved?.response ?? '' })}
        onBlur={() => { void drafts.flush(key); }}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void drafts.flush(key); } }} />
      <div className="flex items-center justify-between gap-2"><span role="status" className="text-xs text-muted-foreground">{!saved ? 'AI 답변이 없습니다.' : draft?.saving ? '저장 중…' : draft?.error ? '저장 실패 · 입력 내용 유지됨' : draft && draft.text !== draft.saved ? '저장 대기…' : '저장됨'}</span>
        <button className="rounded border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-40" disabled={!draft || draft.saving || draft.text === draft.saved} onClick={() => { void drafts.flush(key); }}>{draft?.error ? '다시 저장' : '답변 저장'}</button></div>
      {draft?.error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{draft.error}</p>}
    </article>;
  };
  return <section aria-label="현재 장의 답변서 편집" className="min-h-0 flex-1 overflow-auto p-4">
    <header className="mb-4 space-y-2"><h2 className="text-sm font-semibold">{data.filename.replace(/\.scholarpen\.json$/, '')} · 답변서</h2><p className="text-xs leading-5 text-muted-foreground">입력을 멈추면 수정 사본의 답변서에 자동 저장됩니다. 여러 장에 연결된 의견은 같은 답변을 함께 사용합니다. 수정한 원고와 답변이 일치하는지 확인해 주세요.</p></header>
    <div className="space-y-4">{data.comments.filter(c => c.scope === 'chapter').map(render)}</div>
    {!data.comments.some(c => c.scope === 'chapter') && <p className="text-sm text-muted-foreground">이 장에 명시적으로 연결된 답변이 없습니다.</p>}
    {data.comments.some(c => c.scope === 'unlocated') && <details className="mt-4 rounded border border-border p-3"><summary className="cursor-pointer text-sm">장 위치가 지정되지 않은 의견</summary><div className="mt-3 space-y-4">{data.comments.filter(c => c.scope === 'unlocated').map(render)}</div></details>}
  </section>;
}
