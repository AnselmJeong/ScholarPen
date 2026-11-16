import React, { useRef, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { Check, ChevronDown, ChevronUp, PenLine, RotateCcw, X } from "lucide-react";
import type { SuggestionHunk } from "../../collab/suggestion-hunks";
import type { ThreadSnapshot } from "../../../shared/collab/threads";
import { isAIUser } from "../../../shared/collab/personas";
import type { ProposalEntry } from "../../../shared/collab/review-proposals";
import {
  acceptProposal,
  dismissProposal,
  finishRewrite,
  redoProposal,
  rejectProposal,
  rewriteProposal,
} from "../../collab/review-proposals";

export interface ProposalItem {
  entry: ProposalEntry;
  hunks: SuggestionHunk[];
  changeSetId?: number;
  thread?: ThreadSnapshot;
}

type Phase = "review" | "working" | "answered" | "editing" | "unplaced";

function phaseOf({ entry, hunks, changeSetId, thread }: ProposalItem): Phase {
  if (entry.state === "editing") return "editing";
  if (entry.state === "unplaced") return "unplaced";
  if (changeSetId !== undefined && hunks.length) return "review";
  if (entry.state === "redo" && (!thread || thread.meta.status === "in-progress" || thread.meta.assignee === "ai")) return "working";
  return "answered";
}

function statusLine(item: ProposalItem, phase: Phase) {
  const round = item.entry.redoCount ?? 0;
  switch (phase) {
    case "review":
      if (item.entry.state === "redo") return `AI 재수정안${round > 1 ? ` ${round}차` : ""} · 저자 확인 필요`;
      return item.entry.origin === "deferred" ? "자동 검토가 보류한 수정안 · 저자 확인 필요" : "AI 수정안 · 저자 확인 필요";
    case "working": return "AI가 새 수정안을 작성하는 중…";
    case "answered": return "AI 답변 · 새 수정안 없음";
    case "editing": return "수정안을 반영했습니다 · 본문에서 직접 고쳐 쓰는 중";
    case "unplaced": return "원고에서 수정 위치를 찾지 못함";
  }
}

const inserted = (hunks: SuggestionHunk[]) => hunks.map((hunk) => hunk.inserted).filter(Boolean).join(" … ");

/** Margin card of one Review & Revision proposal: reviewer request, the change, and the author's options. */
export function ProposalCard({ editor, item, number, selected, onSelect }: {
  editor: BlockNoteEditor<any, any, any>;
  item: ProposalItem;
  number: number;
  selected: boolean;
  onSelect: (scroll: boolean) => void;
}) {
  const { entry, hunks, changeSetId, thread } = item;
  const phase = phaseOf(item);
  const [details, setDetails] = useState(false);
  const [asking, setAsking] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const label = `Reviewer revision ${number}`;
  const comments = entry.comments.map((comment) => comment.id).join(", ") || entry.id;
  const request = entry.comments.map((comment) => comment.text.trim()).join("\n\n");
  const aiReply = [...(thread?.comments ?? [])].reverse().find((comment) => !comment.deleted && isAIUser(comment.userId))?.text;
  const previous = entry.state === "pending" ? entry.after : entry.state === "unplaced" ? entry.after : inserted(hunks);
  const canDecide = phase === "review" && changeSetId !== undefined;

  const send = () => {
    redoProposal(editor, entry, canDecide ? changeSetId : undefined, previous, field.current?.value.trim() ?? "");
    setAsking(false);
  };

  return <>
    <div className="sp-margin-card-header">
      <button type="button" className="sp-margin-title" onClick={() => onSelect(true)} aria-label={`${label}: show in text`} aria-pressed={selected}>
        <span className="sp-margin-number">{number}</span>
        <span>심사 반영</span>
        <span className="sp-margin-detail">· {comments}</span>
      </button>
      {canDecide && <>
        <button type="button" className="sp-margin-action" aria-label={`Accept ${label}`} title="확인 — 수정안을 원고에 반영"
          onClick={() => acceptProposal(editor, entry, changeSetId!)}><Check size={14} /></button>
        <button type="button" className="sp-margin-action" aria-label={`Rewrite ${label}`} title="반영한 뒤 본문에서 직접 고쳐 쓰기"
          onClick={() => rewriteProposal(editor, entry, changeSetId!)}><PenLine size={13} /></button>
        <button type="button" className="sp-margin-action" aria-label={`Reject ${label}`} title="거절 — 원문 유지"
          onClick={() => rejectProposal(editor, entry, changeSetId)}><X size={14} /></button>
      </>}
    </div>
    <p className="sp-proposal-status" data-phase={phase}>{statusLine(item, phase)}</p>
    {request && <button type="button" className="sp-proposal-request" data-open={details} onClick={() => setDetails(!details)}
      aria-expanded={details} title={details ? "접기" : "심사의견 전체 보기"}>
      <span className="sp-proposal-caption">심사의견</span>{request}
    </button>}
    {phase === "review" && entry.state === "pending" && <div className="sp-margin-excerpt sp-proposal-diff">
      <span className="sp-proposal-caption">원문 → 수정안</span>
      <del>{entry.before.trim()}</del>{" "}<ins>{entry.after.trim()}</ins>
    </div>}
    {phase === "review" && entry.state !== "pending" && <div className="sp-margin-excerpt sp-proposal-diff">
      {hunks.map((hunk, index) => <React.Fragment key={`${hunk.from}:${index}`}>
        {index > 0 && <span className="sp-margin-detail"> … </span>}
        {hunk.deleted && <del>{hunk.deleted}</del>}{hunk.deleted && hunk.inserted && " "}{hunk.inserted && <ins>{hunk.inserted}</ins>}
      </React.Fragment>)}
    </div>}
    {(phase === "editing" || phase === "unplaced") && <div className="sp-margin-excerpt sp-proposal-diff">
      <span className="sp-proposal-caption">{phase === "editing" ? "검토 전 원문" : "검토 당시 수정안"}</span>
      {phase === "editing" ? <del>{entry.before}</del> : <ins>{entry.after}</ins>}
    </div>}
    {phase === "unplaced" && entry.note && <p className="sp-proposal-warning">{entry.note}</p>}
    {entry.origin === "deferred" && entry.reason && entry.state === "pending" && <p className="sp-proposal-warning">보류 사유: {entry.reason}</p>}
    {phase !== "working" && entry.rationale && (entry.state !== "redo" || !aiReply) &&
      <p className="sp-proposal-rationale" data-open={details}><span className="sp-proposal-caption">AI 근거</span>{entry.rationale}</p>}
    {entry.state === "redo" && aiReply && phase !== "working" &&
      <p className="sp-proposal-rationale" data-open={details}><span className="sp-proposal-caption">AI 답변</span>{aiReply}</p>}
    {entry.instruction && entry.state === "redo" &&
      <p className="sp-margin-detail sp-proposal-instruction">내 지시: {entry.instruction}</p>}
    <button className="sp-margin-link" type="button" aria-expanded={details} onClick={() => setDetails(!details)}>
      {details ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {details ? "접기" : "자세히"}
    </button>
    {phase === "editing" && <div className="sp-proposal-actions">
      <button type="button" className="sp-proposal-button" data-primary onClick={() => finishRewrite(editor, entry)}>고쳐 쓰기 완료</button>
    </div>}
    {asking ? <form className="sp-proposal-ask" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <label className="sp-proposal-caption" htmlFor={`proposal-ask-${entry.key}`}>
        {canDecide ? "이 수정안을 거절하고 AI에게 다시 요청" : "AI에게 수정안 요청"}
      </label>
      <textarea id={`proposal-ask-${entry.key}`} ref={field} rows={3} autoFocus
        placeholder="예: 수치는 원문 확인 전까지 빼고, 한계만 한 문장으로 덧붙여 주세요."
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") setAsking(false);
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); }
        }} />
      <div className="sp-proposal-actions">
        <button type="button" className="sp-proposal-button" onClick={() => setAsking(false)}>취소</button>
        <button type="submit" className="sp-proposal-button" data-primary>{canDecide ? "거절하고 요청" : "요청 보내기"}</button>
      </div>
    </form> : phase !== "editing" && <div className="sp-proposal-actions">
      {phase !== "working" && <button type="button" className="sp-proposal-button" onClick={() => setAsking(true)}>
        <RotateCcw size={12} /> {canDecide ? "거절하고 AI에게 다시 요청" : "AI에게 요청"}
      </button>}
      {!canDecide && <button type="button" className="sp-proposal-button" onClick={() => dismissProposal(editor, entry)}>
        {phase === "working" ? "요청 취소" : "닫기"}
      </button>}
    </div>}
  </>;
}
