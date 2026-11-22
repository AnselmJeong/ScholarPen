import type { BlockNoteEditor } from "@blocknote/core";
import type * as Y from "yjs";
import type { AssistantEditChange, AssistantEditOutcome, AssistantEditResult, RemovedCitation } from "@shared/agent-document-edit";
import { REVISIONS_MAP, type RevisionEntry, type RevisionStatus } from "@shared/collab/revision-log";
import { getEditorCollab } from "../collab/editor-collab";

/**
 * The Assistant tab's side of a manuscript edit: the result Bun reports for
 * it, the author's later decision on its change set, and the chat banner that
 * says both.
 */

/** What became of one document's edit block. */
export type AssistantEditDispatch =
  | { ok: true; result: AssistantEditResult; ydoc: Y.Doc }
  /** The document is not in the project, its editor never joined the shared document, or the request failed. */
  | { ok: false; reason: "not-found" | "not-ready" | "failed"; error?: string };

/** Waits until the document's editor is mounted and joined to its shared Y.Doc. */
export async function waitForDocumentEditor(
  find: () => BlockNoteEditor<any, any, any> | null,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<BlockNoteEditor<any, any, any> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const editor = find();
    if (editor && getEditorCollab(editor)) return editor;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export type EditDecision = Exclude<RevisionStatus, "pending" | "applied">;

/**
 * Reports once the author has kept, reverted or partly kept the change set
 * (the revision log entry leaves "pending"), then stops watching.
 */
export function watchEditDecision(ydoc: Y.Doc, revisionId: string, onDecision: (decision: EditDecision) => void): () => void {
  const revisions = ydoc.getMap<RevisionEntry>(REVISIONS_MAP);
  let finished = false;
  const check = () => {
    if (finished) return;
    const status = revisions.get(revisionId)?.status;
    if (status === "accepted" || status === "rejected" || status === "partial") {
      stop();
      onDecision(status);
    }
  };
  const stop = () => {
    if (finished) return;
    finished = true;
    revisions.unobserve(check);
  };
  revisions.observe(check);
  check();
  return stop;
}

export interface DocumentEditNotice {
  status: "info" | "success" | "warning";
  title: string;
  description?: string;
  /** One line per change that was not applied. */
  items?: string[];
}

export type AssistantEditState =
  | { state: "applying"; count: number }
  | { state: "refused"; reason: "invalid-target" | "letter" | "unfinished" | "malformed" | "not-found" | "not-ready" }
  | { state: "failed"; error?: string }
  | { state: "done"; result: AssistantEditResult; changes: AssistantEditChange[]; malformed: number }
  | { state: "decided"; decision: EditDecision; applied: number };

type Lang = "ko" | "en";

function clipQuote(text: string, limit = 60) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Why one change was not applied, in the chat's language. */
export function refusalText(outcome: AssistantEditOutcome, lang: Lang): string {
  const ko = lang === "ko";
  const detail = outcome.detail ?? "";
  switch (outcome.reason) {
    case "observe": return ko ? "이 섹션은 Observe로 설정되어 AI 수정을 받지 않습니다." : "This section is set to Observe, so it takes no AI edits.";
    case "pending": return ko ? "이 문단에 아직 결정하지 않은 수정 제안이 있습니다. 먼저 Keep 또는 Revert로 정리하세요." : "This paragraph still has pending suggested changes. Keep or revert them first.";
    case "not-found": return ko ? "인용한 문장을 문서에서 찾지 못했습니다. 그 사이 문서가 바뀌었을 수 있습니다." : "The quoted text is not in the document; it may have changed meanwhile.";
    case "ambiguous": return ko ? "인용한 문장이 문단에 여러 번 나와 어느 곳인지 정할 수 없습니다." : "The quoted text occurs more than once, so the place is unclear.";
    case "overlap": return ko ? "같은 곳을 고치는 다른 수정과 겹칩니다." : "It overlaps another change to the same text.";
    case "level": return ko ? `편집 수준 한도를 넘는 변경이라 적용하지 않았습니다 (${detail}). 편집 수준을 올리면 허용됩니다.` : `The change exceeds the document's edit level (${detail}). Raise the level to allow it.`;
    case "atom":
      if (detail === "\n") return ko ? "고친 문장에서 줄바꿈이 빠지게 되어 적용하지 않았습니다. 줄바꿈은 그 부분을 통째로 지울 때만 함께 지워집니다." : "It would drop a line break from the passage it rewrites; a line break goes only with a passage deleted outright.";
      return ko ? `인용·수식·상호참조 ${detail}를 일부만 인용한 채 지우거나 바꾸게 되어 적용하지 않았습니다. 지우거나 바꾸려면 통째로 인용해야 합니다.` : `It would remove or alter ${detail}, which the quoted text holds only in part. Quote it whole to change or delete it.`;
    case "format":
      if (detail === "markup") return ko ? "본문에 그대로 둔 기호(코드, _, * 등)를 일부만 바꾸게 되어 적용하지 않았습니다. 통째로 지우거나 편집기에서 직접 고쳐 주세요." : "It would change protected literal markup (code, _, * …) only in part. Delete it whole, or change it in the editor.";
      return ko ? "인용·수식 사이에 새 글자를 넣게 되어 적용하지 않았습니다. 편집기에서 직접 고쳐 주세요." : "It would add text between two citations or equations, where nothing can hold it. Change it in the editor.";
    case "markup": return ko ? `새 문장에 Markdown 서식(${detail})이 있어 글자 그대로 들어가므로 적용하지 않았습니다.` : `The new text has Markdown (${detail}) that would appear as literal characters.`;
    case "not-prose": return ko ? "코드·표·그림·수식 블록은 이 방식으로 고칠 수 없습니다." : "Code, tables, figures and equations cannot be edited this way.";
    case "unchanged": return ko ? "바뀌는 내용이 없습니다." : "It changes nothing.";
    case "conflict": return ko ? `적용 직전 확인에서 막혔습니다: ${detail}` : `The stale check stopped it: ${detail}`;
    default: return ko ? "적용하지 않았습니다." : "Not applied.";
  }
}

export function removedCitationText(citation: RemovedCitation, lang: Lang): string {
  const ko = lang === "ko";
  const cite = `[@${citation.key}]`;
  switch (citation.why) {
    case "proofread": return ko ? `Proofread 수준에서는 새 인용을 넣지 않아 ${cite}를 뺐습니다.` : `Left out ${cite}: the Proofread edit level adds no citations.`;
    case "no-library": return ko ? `references.bib를 읽지 못해 새 인용 ${cite}를 뺐습니다.` : `Left out ${cite}: references.bib could not be read.`;
    default: return ko ? `${cite}는 references.bib에 없어 뺐습니다. 문헌을 먼저 추가해 주세요.` : `Left out ${cite}: it is not in references.bib. Add the reference first.`;
  }
}

/** The Assistant tab's banner for one document's edit, in the chat's language. */
export function describeAssistantEdit(edit: AssistantEditState, name: string, lang: Lang): DocumentEditNotice {
  const ko = lang === "ko";
  switch (edit.state) {
    case "applying":
      return { status: "info", title: ko ? `${name} 문서에 수정 ${edit.count}곳을 적용하고 있습니다…` : `Applying ${edit.count} change${edit.count === 1 ? "" : "s"} to ${name}…` };
    case "refused": {
      const titles = {
        "invalid-target": ko ? `'${name}'은(는) 이 프로젝트의 원고 문서가 아니어서 고치지 않았습니다.` : `'${name}' is not a manuscript of this project, so it was not edited.`,
        letter: ko ? `'${name}'은(는) 답신서 문서라 Assistant가 고치지 않습니다.` : `'${name}' is a response letter, which the Assistant does not edit.`,
        unfinished: ko ? "수정 블록이 끝까지 작성되지 않아 아무것도 고치지 않았습니다. 다시 요청해 주세요." : "The edit was cut off, so nothing was changed. Please ask again.",
        malformed: ko ? `${name} 수정 블록의 형식이 잘못되어 아무것도 고치지 않았습니다.` : `The edit for ${name} was malformed, so nothing was changed.`,
        "not-found": ko ? `프로젝트에서 ${name} 문서를 찾지 못해 고치지 않았습니다.` : `${name} was not found in the project, so it was not edited.`,
        "not-ready": ko ? `${name} 문서를 열지 못해 고치지 않았습니다. 문서를 연 뒤 다시 요청해 주세요.` : `${name} could not be opened, so it was not edited. Open it and ask again.`,
      };
      return { status: "warning", title: titles[edit.reason] };
    }
    case "failed":
      return { status: "warning", title: ko ? `${name} 문서를 고치지 못했습니다.` : `${name} could not be edited.`, description: edit.error };
    case "done": {
      const { result, changes } = edit;
      if (result.status !== "applied" && result.reason) {
        const titles = {
          "not-open": ko ? `${name} 문서가 열려 있지 않아 고치지 않았습니다.` : `${name} is not open, so it was not edited.`,
          letter: ko ? `'${name}'은(는) 답신서 문서라 Assistant가 고치지 않습니다.` : `'${name}' is a response letter, which the Assistant does not edit.`,
          paused: ko ? "Activity 탭에서 AI 편집이 일시 중지되어 있어 고치지 않았습니다." : "AI editing is paused in the Activity tab, so nothing was changed.",
          empty: ko ? "적용할 수정이 없습니다." : "There was nothing to change.",
          timeout: ko ? `${name} 수정이 AI 작업 대기열에서 오래 기다리고 있습니다. 결과는 Activity 탭에서 확인하세요.` : `The edit to ${name} is still waiting in the AI queue. Check the Activity tab for the result.`,
        };
        return { status: result.reason === "timeout" ? "info" : "warning", title: titles[result.reason] };
      }
      if (result.status === "failed") {
        return { status: "warning", title: ko ? `${name} 문서를 고치지 못했습니다.` : `${name} could not be edited.`, description: result.error };
      }
      const applied = result.outcomes.filter((outcome) => outcome.applied).length;
      const refused = result.outcomes.filter((outcome) => !outcome.applied);
      const items = refused.map((outcome) => `“${clipQuote(changes[outcome.index]?.old ?? "")}” — ${refusalText(outcome, lang)}`);
      if (edit.malformed) items.push(ko ? `형식이 잘못된 수정 ${edit.malformed}개는 건너뛰었습니다.` : `${edit.malformed} malformed change(s) were skipped.`);
      items.push(...result.removedCitations.map((citation) => removedCitationText(citation, lang)));
      if (!applied) {
        return { status: "warning", title: ko ? `${name} 문서를 고치지 않았습니다.` : `${name} was not changed.`, items };
      }
      const total = applied + refused.length + edit.malformed;
      return {
        status: refused.length || edit.malformed ? "warning" : "success",
        title: ko
          ? `${name} 문서에 수정 ${applied}곳을 추적 변경으로 넣었습니다${applied < total ? ` (${total}곳 중)` : ""}.`
          : `Added ${applied} of ${total} change${total === 1 ? "" : "s"} to ${name} as tracked changes.`,
        description: ko
          ? "여백의 Revision 카드나 아래 검토 막대에서 바뀐 곳마다 Keep 또는 Revert로 결정하세요."
          : "Keep or revert each change from its Revision card in the margin or the review bar.",
        items: items.length ? items : undefined,
      };
    }
    case "decided": {
      const titles: Record<EditDecision, string> = {
        accepted: ko ? `${name}: Assistant 수정 ${edit.applied}곳을 모두 유지했습니다.` : `${name}: you kept all ${edit.applied} of the Assistant's changes.`,
        rejected: ko ? `${name}: Assistant 수정을 되돌렸습니다.` : `${name}: you reverted the Assistant's changes.`,
        partial: ko ? `${name}: Assistant 수정 일부만 유지했습니다.` : `${name}: you kept some of the Assistant's changes.`,
      };
      return { status: edit.decision === "rejected" ? "info" : "success", title: titles[edit.decision] };
    }
  }
}
