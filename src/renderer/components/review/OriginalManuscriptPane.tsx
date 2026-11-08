import React from 'react';
import type { RevisionContextState } from './RevisionContextPanel';
import { ReadOnlyManuscript } from './ReviewWorkspace';
export function OriginalManuscriptPane({ state }: { state: RevisionContextState }) {
  const { data, error, loading } = state;
  return <section aria-label="비교용 원본 원고" className="flex h-full min-h-0 flex-col bg-background">
    <header className="shrink-0 border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">원본 · 읽기 전용</h2><p className="mt-1 text-xs text-muted-foreground">노란 표시: AI가 변경한 문단 · 오른쪽 수정본에서 직접 편집하세요.</p></header>
    <div className="min-h-0 flex-1 overflow-auto p-3">{loading ? <p role="status" className="p-3 text-sm">원본을 불러오는 중…</p> : error ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p> : !data?.original ? <p className="p-3 text-sm text-muted-foreground">이 장에 연결된 원본이 없습니다.</p> : <ReadOnlyManuscript text={JSON.stringify({ [data.filename]: data.original })} address={data.address} round={0} changedBlocks={data.changes.map(c => c.target.split('#')[1]?.split(':')[0] ?? '')} />}</div>
  </section>;
}
