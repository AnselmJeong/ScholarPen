import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { BlockNoteEditor } from "@blocknote/core";
import type { AssistantEditChange, AssistantEditResult } from "@shared/agent-document-edit";
import { recordRevision, REVISIONS_MAP, settleRevision, type RevisionEntry } from "@shared/collab/revision-log";
import { setEditorCollab } from "../collab/editor-collab";
import type { CollabPeer } from "../collab/collab-peer";
import { describeAssistantEdit, waitForDocumentEditor, watchEditDecision, type EditDecision } from "./document-edit-request";

const changes: AssistantEditChange[] = [
  { paragraph: "p1", old: "These results prove that the drug causes recovery.", new: "These results suggest that the drug may aid recovery." },
  { paragraph: "p2", old: "Earlier trials reported similar effects [@smith2020]", new: "Earlier trials reported similar effects" },
  { paragraph: "p4", old: "We recieve", new: "We received" },
];

const result = (patch: Partial<AssistantEditResult>): AssistantEditResult => ({ status: "applied", outcomes: [], removedCitations: [], ...patch });

describe("describeAssistantEdit", () => {
  test("reports what was applied and why the rest was not", () => {
    const notice = describeAssistantEdit({ state: "done", changes, malformed: 0, result: result({
      changeSetId: 3, revisionId: "rev-1",
      outcomes: [
        { index: 0, applied: true, blockId: "p1" },
        { index: 1, applied: false, reason: "atom", detail: "[@smith2020]" },
        { index: 2, applied: false, reason: "observe" },
      ],
      removedCitations: [{ key: "ghost2000", why: "not-in-library" }],
    }) }, "Methods", "ko");
    expect(notice.status).toBe("warning");
    expect(notice.title).toBe("Methods 문서에 수정 1곳을 추적 변경으로 넣었습니다 (3곳 중).");
    expect(notice.description).toContain("Keep 또는 Revert");
    expect(notice.items).toEqual([
      "“Earlier trials reported similar effects [@smith2020]” — 인용·수식·상호참조 [@smith2020]를 일부만 인용한 채 지우거나 바꾸게 되어 적용하지 않았습니다. 지우거나 바꾸려면 통째로 인용해야 합니다.",
      "“We recieve” — 이 섹션은 Observe로 설정되어 AI 수정을 받지 않습니다.",
      "[@ghost2000]는 references.bib에 없어 뺐습니다. 문헌을 먼저 추가해 주세요.",
    ]);
  });

  test("a fully applied edit is a success; nothing applied is a warning that says why", () => {
    const applied = describeAssistantEdit({ state: "done", changes: changes.slice(0, 1), malformed: 0,
      result: result({ outcomes: [{ index: 0, applied: true }] }) }, "Intro", "en");
    expect(applied).toMatchObject({ status: "success", title: "Added 1 of 1 change to Intro as tracked changes." });
    expect(applied.items).toBeUndefined();

    const refused = describeAssistantEdit({ state: "done", changes: changes.slice(0, 1), malformed: 1,
      result: result({ status: "refused", outcomes: [{ index: 0, applied: false, reason: "level", detail: "72% > 60% (Sentence)" }] }) }, "Intro", "en");
    expect(refused).toMatchObject({ status: "warning", title: "Intro was not changed." });
    expect(refused.items).toEqual([
      "“These results prove that the drug causes recovery.” — The change exceeds the document's edit level (72% > 60% (Sentence)). Raise the level to allow it.",
      "1 malformed change(s) were skipped.",
    ]);
  });

  test("whole-request refusals and failures are explained", () => {
    expect(describeAssistantEdit({ state: "done", changes, malformed: 0, result: result({ status: "refused", reason: "paused" }) }, "Intro", "en").title)
      .toBe("AI editing is paused in the Activity tab, so nothing was changed.");
    expect(describeAssistantEdit({ state: "refused", reason: "letter" }, "response-2026", "ko").title)
      .toBe("'response-2026'은(는) 답신서 문서라 Assistant가 고치지 않습니다.");
    expect(describeAssistantEdit({ state: "failed", error: "Could not locate the edited block." }, "Intro", "en"))
      .toEqual({ status: "warning", title: "Intro could not be edited.", description: "Could not locate the edited block." });
    expect(describeAssistantEdit({ state: "applying", count: 3 }, "Intro", "ko").title).toBe("Intro 문서에 수정 3곳을 적용하고 있습니다…");
  });

  test("the author's later decision replaces the report", () => {
    expect(describeAssistantEdit({ state: "decided", decision: "accepted", applied: 2 }, "Intro", "en"))
      .toEqual({ status: "success", title: "Intro: you kept all 2 of the Assistant's changes." });
    expect(describeAssistantEdit({ state: "decided", decision: "rejected", applied: 2 }, "Intro", "ko"))
      .toEqual({ status: "info", title: "Intro: Assistant 수정을 되돌렸습니다." });
  });
});

describe("watchEditDecision", () => {
  test("reports once the change set is kept, reverted or partly kept, then stops", () => {
    const ydoc = new Y.Doc();
    const revisions = ydoc.getMap<RevisionEntry>(REVISIONS_MAP);
    const id = recordRevision(revisions, { createdAt: 1, kind: "assistant", label: "Assistant: edit", changeSetId: 4, status: "pending", summary: "", items: [], paragraphs: [] });
    const seen: EditDecision[] = [];
    const stop = watchEditDecision(ydoc, id, (decision) => seen.push(decision));
    expect(seen).toEqual([]);
    settleRevision(revisions, 4, "partial", 2);
    revisions.set(id, { ...revisions.get(id)!, status: "accepted" });
    expect(seen).toEqual(["partial"]);
    stop();
  });

  test("an entry decided before watching is reported at once", () => {
    const ydoc = new Y.Doc();
    const revisions = ydoc.getMap<RevisionEntry>(REVISIONS_MAP);
    const id = recordRevision(revisions, { createdAt: 1, kind: "assistant", label: "x", changeSetId: 1, status: "rejected", summary: "", items: [], paragraphs: [] });
    const seen: EditDecision[] = [];
    watchEditDecision(ydoc, id, (decision) => seen.push(decision));
    expect(seen).toEqual(["rejected"]);
  });
});

describe("waitForDocumentEditor", () => {
  test("waits until the editor has joined its shared document", async () => {
    const editor = {} as BlockNoteEditor<any, any, any>;
    let found: BlockNoteEditor<any, any, any> | null = null;
    setTimeout(() => { found = editor; }, 20);
    setTimeout(() => setEditorCollab(editor, { ydoc: new Y.Doc() } as CollabPeer), 40);
    expect(await waitForDocumentEditor(() => found, 1_000, 5)).toBe(editor);
    expect(await waitForDocumentEditor(() => null, 30, 5)).toBeNull();
  });
});
