import { afterAll, expect, mock, test } from "bun:test";
import { installDom } from "../../test-support/dom";
// The browser environment comes first: react-dom checks for DOM events when it loads.
const env = installDom();
const dom = env.dom;
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { FinishFlow, ResponseText } = await import("./ReviewWorkspace");
afterAll(() => env.restore());

const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find(item => item.textContent?.includes(text)) as HTMLButtonElement | undefined;

test("a session decided in the manuscript finishes with the letter, not another review", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const calls: string[] = [];
  const sync = {
    comments: [{ commentId: "R1-C02", proposals: 2, waiting: 1, ready: false, current: false }, { commentId: "R1-C03", proposals: 1, waiting: 0, ready: true, current: true }],
    proposals: [{ key: "s/C1-p2", id: "C1-p2", document: "04.scholarpen.json", blockId: "b", state: "pending", commentIds: ["R1-C02"] },
      { key: "s/A1-p1", id: "A1-p1", document: "04.scholarpen.json", blockId: "b", state: "accepted", commentIds: ["R1-C02"] },
      { key: "s/C1-p3", id: "C1-p3", document: "08.scholarpen.json", blockId: "c", state: "edited", commentIds: ["R1-C03"] }],
  };
  const render = (waiting: number, notes: number) => act(async () => { root.render(<FinishFlow busy={false} sync={sync as any} waiting={waiting} stale={0} notes={notes}
    onContinue={() => calls.push("continue")} onBuild={() => calls.push("build")} onExport={() => calls.push("export")} onRestage={() => calls.push("restage")} />); });
  await render(1, 0);
  expect(container.textContent).toContain("수정안 3개 중 1개 남음");
  expect(container.textContent).not.toContain("후속");
  await act(async () => { button(container, "원고에서 결정 계속하기")!.click(); });
  await render(0, 1);
  expect(container.textContent).toContain("수정안 3개 모두 결정");
  expect(container.textContent).toContain("보내기 전에 채울 메모 1개");
  expect(button(container, "원고에서 결정 계속하기")).toBeUndefined();
  await act(async () => { button(container, "답신서 만들기")!.click(); button(container, "답신서 내보내기")!.click(); });
  expect(calls).toEqual(["continue", "build", "export"]);
  await act(async () => { root.unmount(); }); container.remove();
});

test("editing a response keeps the draft when saving fails", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let fail = true; const saved: string[] = [];
  await act(async () => { root.render(<ResponseText text={"수정하였습니다. [저자: 이유를 적어 주세요]"} editable busy={false}
    onSave={async text => { if (fail) throw new Error("conflict"); saved.push(text); }} />); });
  await act(async () => { button(container, "답변 고치기")!.click(); });
  const field = container.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  await act(async () => { setter.call(field, "수정하였습니다. 인용은 삭제하였습니다."); for (const type of ["input", "change", "keyup"]) field.dispatchEvent(new dom.Event(type, { bubbles: true }) as any); });
  await act(async () => { button(container, "저장")!.click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("conflict");
  expect(container.querySelector("textarea")).not.toBeNull();
  fail = false;
  await act(async () => { button(container, "저장")!.click(); });
  expect(saved).toHaveLength(1);
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => { root.unmount(); }); container.remove();
});
