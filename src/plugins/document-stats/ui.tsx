import React, { useEffect, useState } from "react";
import type { ExtensionUIProps } from "../../renderer/extensions/slots";
import { acceptedText } from "../../renderer/extensions/document-snapshot";
import { countText, type TextStatistics } from "./count";

export default function DocumentStatistics({ workspace }: ExtensionUIProps) {
  const { editor, activeFile } = workspace;
  const [stats, setStats] = useState<{ document: TextStatistics; selected: TextStatistics | null; revision: number } | null>(null);
  useEffect(() => {
    setStats(null);
    if (!editor || activeFile?.kind !== "document") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false, revision = 0;
    const update = () => {
      if (disposed) return;
      if (editor.prosemirrorView?.composing) { timer = setTimeout(update, 120); return; }
      const state = editor.prosemirrorView?.state;
      if (!state) return;
      setStats({ document: countText(acceptedText(state.doc)),
        selected: state.selection.empty ? null : countText(acceptedText(state.doc, state.selection.from, state.selection.to)), revision: ++revision });
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 120); };
    const stopChange = editor.onChange(schedule);
    const stopSelection = editor.onSelectionChange(schedule);
    schedule();
    return () => { disposed = true; clearTimeout(timer); stopChange(); stopSelection(); };
  }, [editor, activeFile?.path]);
  if (!stats) return null;
  const current = stats.selected ?? stats.document;
  return <details className="relative">
    <summary className="cursor-pointer whitespace-nowrap" aria-label="Document statistics">{stats.selected ? "Selection: " : ""}{current.words.toLocaleString()} words</summary>
    <div className="absolute bottom-7 right-0 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <p className="font-medium">{stats.selected ? "선택 영역" : "문서 통계"}</p>
      <dl className="mt-2 grid grid-cols-2 gap-1">
        <dt>단어</dt><dd>{current.words.toLocaleString()}</dd>
        <dt>글자 (grapheme)</dt><dd>{current.graphemes.toLocaleString()}</dd>
        <dt>공백 제외</dt><dd>{current.nonWhitespace.toLocaleString()}</dd>
        <dt>어절 (공백 기준)</dt><dd>{current.eojeol.toLocaleString()}</dd>
        <dt>문단</dt><dd>{current.paragraphs.toLocaleString()}</dd>
      </dl>
      <p className="mt-2 text-[10px] text-muted-foreground">Intl.Segmenter 기준. 미수락 추가 제안, 코드, 인용·수식 노드는 제외합니다. 이력 통계와 집계 기준이 다릅니다.</p>
    </div>
  </details>;
}
