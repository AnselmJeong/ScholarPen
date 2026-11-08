import React, { useEffect, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import type { RevisionChapterContext } from '../../../shared/review-session/chapter-context';
import { rpc } from '../../rpc';
const disposition: Record<string, string> = { changed: 'AI 수정 반영', 'partially-addressed': '일부 반영', 'needs-author': '저자 확인 필요', unresolved: '미해결', 'clarified-no-change': '수정 없이 설명', 'reasoned-disagreement': '수정하지 않는 근거', 'awaiting-figure-approval': '그림 확인 필요' };
const button = 'rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40';
export function useRevisionContext(projectPath?: string, filename?: string) {
  const [data, setData] = useState<RevisionChapterContext | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false; setData(null); setError('');
    if (!projectPath || !filename) { setLoading(false); return; }
    setLoading(true);
    rpc.reviewRevisionContext(projectPath, filename).then(value => { if (!cancelled) setData(value); }).catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, filename]);
  return { data, error, loading };
}
export type RevisionContextState = ReturnType<typeof useRevisionContext>;
export function RevisionContextPanel({ state, filename, editor, onShowManuscript }: { state: RevisionContextState; filename?: string; onShowManuscript?: () => void; editor: BlockNoteEditor<any, any, any> | null }) {
  const { data, error, loading } = state;
  const [notice, setNotice] = useState('');
  const jump = (target: string) => {
    const id = target.split('#')[1]?.split(':')[0];
    if (!editor || !id || !editor.getBlock(id)) { setNotice('현재 원고에서 이 위치를 찾지 못했습니다. 문단이 이동·삭제됐을 수 있습니다.'); return; }
    onShowManuscript?.();
    requestAnimationFrame(() => {
    try { editor.setTextCursorPosition(id, 'start'); editor.focus(); editor.domElement?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }); setNotice('본문의 해당 위치로 이동했습니다.'); }
    catch { setNotice('이 위치는 직접 커서를 놓을 수 없습니다. 표·그림 위치를 본문에서 확인해 주세요.'); }
    });
  };
  const renderComment = (item: RevisionChapterContext['comments'][number]) => <article key={item.comment.id} className="space-y-3 rounded-lg border border-border p-3">
    <p className="text-xs font-semibold text-primary">{item.comment.reviewerId} · {item.comment.id}</p>
    <div><h3 className="mb-1 text-xs font-semibold">심사자 지적</h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{item.comment.original}</p></div>
    <div className="border-t border-border pt-3"><h3 className="mb-1 text-xs font-semibold">AI 답변 · {disposition[item.response?.disposition ?? ''] ?? '답변 없음'}</h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{item.response?.response || '이 의견의 답변을 직접 확인해 주세요.'}</p></div>
    <div className="flex flex-wrap gap-2">{data?.changes.filter(c => c.commentIds.includes(item.comment.id)).map(c => <button key={c.id} className={button} onClick={() => jump(c.target)}>{c.id} 본문 위치</button>)}</div>
  </article>;
  return <section aria-label="수정 원고 검토 자료" className="flex min-h-0 flex-1 flex-col">
    <header className="space-y-2 border-b border-border p-4"><h2 className="break-words text-sm font-semibold">{filename?.replace(/\.scholarpen\.json$/, '') || '수정 원고 검토'}</h2><p className="text-xs leading-5 text-muted-foreground">이 장의 심사자 지적과 AI 답변입니다. 답변은 AI 검토 완료 시점의 내용이므로, 본문을 직접 수정한 뒤에는 일치 여부를 확인해 주세요.</p></header>
    {loading ? <p role="status" className="p-4 text-sm">이 장의 검토 자료를 불러오는 중…</p> : error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : !data ? <p className="p-4 text-sm text-muted-foreground">revisions 폴더의 원고를 열면 해당 장의 비교 자료가 표시됩니다. 새로 추가한 장에는 이전 검토 자료가 없습니다.</p> : <>
      {notice && <p role="status" className="px-4 pt-3 text-xs text-muted-foreground">{notice}</p>}
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {data.comments.filter(c => c.scope === 'chapter').map(renderComment)}
        {!data.comments.some(c => c.scope === 'chapter') && <p className="text-sm text-muted-foreground">이 장에 명시적으로 연결된 의견이 없습니다.</p>}
        {data.comments.some(c => c.scope === 'unlocated') && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">장 위치가 지정되지 않은 의견 ({data.comments.filter(c => c.scope === 'unlocated').length})</summary><p className="my-3 text-xs leading-5 text-muted-foreground">누락되지 않도록 함께 표시합니다. 이 장과 관련 있는지는 직접 확인해 주세요.</p><div className="space-y-3">{data.comments.filter(c => c.scope === 'unlocated').map(renderComment)}</div></details>}
        {!!data.checks.length && <details open className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"><summary className="cursor-pointer text-sm font-semibold">저자 확인 필요 ({data.checks.length})</summary>{data.checks.map(c => <div key={c.id} className="mt-3 space-y-2 border-t border-border pt-3 text-xs leading-5"><p className="font-semibold">{c.id} · {c.commentIds.join(', ')}</p><p>{c.reason}</p><p className="whitespace-pre-wrap break-words">미검증 제안: {c.proposed}</p></div>)}</details>}
      </div>
    </>}
  </section>;
}
