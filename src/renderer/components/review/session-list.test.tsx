import { afterAll, expect, mock, test } from "bun:test";
import { installDom } from "../../test-support/dom";
// The browser environment comes first: react-dom checks for DOM events when it loads.
const env = installDom();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { rpc } = await import("../../rpc");
const { ReviewWorkspace } = await import("./ReviewWorkspace");
const saved = { reviewList: rpc.reviewList, reviewGet: rpc.reviewGet, reviewDelete: rpc.reviewDelete, confirmAction: rpc.confirmAction };
afterAll(() => { Object.assign(rpc, saved); env.restore(); });

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id, status: "completed", completedCycles: 1, createdAt: "2026-11-16T10:52:35.000Z", quality: "needs-author-action",
  input: { mode: "peer", maxCycles: 2, documents: ["00 Abstract.scholarpen.json"] }, ...extra,
}) as any;

test("a session made by mistake can be deleted from the list, after the author confirms", async () => {
  let sessions = [
    session("followup", { input: { mode: "peer", maxCycles: 2, documents: ["00 Abstract.scholarpen.json"], parentSessionId: "main" }, editablePath: "/p/revisions/followup" }),
    session("main"),
    session("running", { status: "running" }),
  ];
  const confirmations: Array<{ message: string; detail?: string }> = [];
  const deleted: string[] = [];
  let answer = false;
  Object.assign(rpc, {
    reviewList: async () => sessions,
    confirmAction: async (options: { message: string; detail?: string }) => { confirmations.push(options); return answer; },
    reviewDelete: async ({ sessionId }: { sessionId: string }) => { deleted.push(sessionId); sessions = sessions.filter(item => item.id !== sessionId); return { trashed: [] }; },
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const noop = async () => {};
  await act(async () => { root.render(<ReviewWorkspace project={{ path: "/p", name: "p", files: [] } as any} files={[]} activeDocument={null}
    prepare={noop} onClose={() => {}} onExported={noop} onOpenProposal={() => {}} />); });
  const trash = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="세션 삭제"]')];
  expect(container.textContent).toContain("후속 세션");
  expect(trash().map(button => button.disabled)).toEqual([false, false, true]);

  await act(async () => { trash()[0]!.click(); });
  expect(confirmations[0]!.message).toContain("후속 세션의 심사 기록과 답신서를 휴지통으로");
  expect(confirmations[0]!.detail).toContain("documents");
  expect(deleted).toEqual([]);

  answer = true;
  await act(async () => { trash()[0]!.click(); });
  expect(deleted).toEqual(["followup"]);
  expect(trash()).toHaveLength(2);
  expect(container.textContent).toContain("휴지통으로 옮겼습니다");
  await act(async () => { root.unmount(); }); container.remove();
});

test("a completed session is finished in the manuscript only: no copy, follow-up or round export", async () => {
  const completed = session("done", { selectedFinalRound: 1, rounds: [{ round: 1, changes: [], responses: [], authorChecks: [] }], comments: [], approvals: [], roles: { reviewer: { model: "gpt" }, reviser: { model: "claude" } }, stage: "completed", allocatedCycles: 1 });
  const legacy = { ...completed, id: "legacy", editablePath: "/p/revisions/legacy" };
  const views: Record<string, any> = {
    done: { session: completed, root: "/p/.scholarpen/reviews/done", responsesMarkdown: "", changes: [] },
    legacy: { session: legacy, root: "/p/.scholarpen/reviews/legacy", responsesMarkdown: "", changes: [] },
  };
  Object.assign(rpc, { reviewList: async () => [completed, legacy], reviewGet: async ({ sessionId }: { sessionId: string }) => views[sessionId] });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const noop = async () => {};
  await act(async () => { root.render(<ReviewWorkspace project={{ path: "/p", name: "p", files: [] } as any} files={[]} activeDocument={null}
    prepare={noop} onClose={() => {}} onExported={noop} onOpenProposal={() => {}} />); });
  const open = async (index: number) => { await act(async () => { container.querySelectorAll<HTMLButtonElement>(".space-y-3 > .relative > button:first-child")[index]!.click(); }); };
  const labels = () => [...container.querySelectorAll("button")].map(button => button.textContent?.trim());
  await open(0);
  expect(labels()).toContain("원고에 수정안 표시");
  for (const gone of ["최종 후보로 후속 세션 만들기", "최신 원고·답변서 내보내기", "수정 원고에서 계속 편집", "자동 검토 원고 내보내기"]) expect(labels()).not.toContain(gone);
  expect(container.textContent).not.toContain("revisions/");
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "세션 목록")!.click(); });
  await open(1);
  expect(labels()).not.toContain("원고에 수정안 표시");
  expect(labels()).toContain("답신서 내보내기");
  expect(container.textContent).toContain("예전 방식");
  await act(async () => { root.unmount(); }); container.remove();
});
