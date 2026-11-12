import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom, isDisabled } from "../../test-support/dom";
const env = installDom();
const dom = env.dom;
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { ProjectMemoryPanel } = await import("./ProjectMemoryPanel");
const status = spyOn(rpc, "getProjectMemoryStatus");
const retain = spyOn(rpc, "retainProjectMemory");
const recall = spyOn(rpc, "recallProjectMemory");
const operation = spyOn(rpc, "getProjectMemoryOperation");
const spies = [status, retain, recall, operation];
let root: Root | undefined;
let container: HTMLDivElement;
async function render(path = "/project-a") {
  status.mockResolvedValue({ state: "ready", bankId: "scholarpen-test", url: "https://hindsight.ecoplay.cloud" });
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(<ProjectMemoryPanel key={path} projectPath={path} sourceName="paper.qmd" getSelection={() => "Confirmed terminology decision"} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
}
function button(text: string) { return Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!; }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove(); localStorage.clear();
  spies.forEach(spy => spy.mockReset());
});
afterAll(() => {
  spies.forEach(spy => spy.mockRestore());
  env.restore();
});

test("selection saves only to current project and reports asynchronous processing honestly", async () => {
  retain.mockResolvedValue({ state: "processing", operationId: "operation-1" });
  await render();
  await act(async () => button("선택문 가져오기").click());
  await act(async () => button("기억 저장").click());
  expect(retain).toHaveBeenCalledWith("/project-a", "Confirmed terminology decision", "paper.qmd");
  expect(container.textContent).toContain("처리하는 중");
  expect(container.textContent).not.toContain("저장이 완료");
  expect(isDisabled(button("기억 저장"))).toBeTrue();
  expect(localStorage.getItem("scholarpen-memory:/project-a")).toContain("operation-1");
});

test("failed save retains draft; switching projects cannot leak draft or late status", async () => {
  retain.mockRejectedValue(new Error("HTTP 503"));
  await render(); await act(async () => button("선택문 가져오기").click());
  await act(async () => button("기억 저장").click());
  expect(container.querySelector("textarea")?.value).toBe("Confirmed terminology decision");
  expect(container.textContent).toContain("HTTP 503");
  await render("/project-b");
  expect(container.querySelector("textarea")?.value).toBe("");
  await render("/project-a");
  expect(container.querySelector("textarea")?.value).toBe("Confirmed terminology decision");
});

test("restored pending save is cleared only after confirmed processing completion", async () => {
  localStorage.setItem("scholarpen-memory:/project-a", JSON.stringify({ content: "note", source: "source", receipt: { state: "processing", operationId: "operation-1" } }));
  operation.mockResolvedValue({ state: "completed" });
  await render();
  expect(isDisabled(button("기억 저장"))).toBeTrue();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2_100)); });
  expect(operation).toHaveBeenCalledWith("/project-a", "operation-1");
  expect(container.textContent).toContain("기억 저장이 완료");
  expect(container.querySelector("textarea")?.value).toBe("");
});
