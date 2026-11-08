import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AIDetectorStatus } from "../../../shared/ai-detector-setup";
const dom = new Window();
const keys = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { AIDetectorSetup } = await import("./AIDetectorSetup");
const status = spyOn(rpc, "getAIDetectorStatus");
const install = spyOn(rpc, "installAIDetector");
const cancel = spyOn(rpc, "cancelAIDetectorInstall");
let root: Root | undefined;
let container: HTMLDivElement;
async function render(compact = false) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<AIDetectorSetup compact={compact} />));
}
const button = (label: string) => [...container.querySelectorAll("button")].find(button => button.textContent === label)!;
const downloading: AIDetectorStatus = { state: "installing", phase: "models", detail: "Downloading", progress: { kind: "files", completed: 12, total: 56 } };
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  for (const spy of [status, install, cancel]) spy.mockReset();
});
afterAll(() => {
  for (const spy of [status, install, cancel]) spy.mockRestore();
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  dom.happyDOM.abort();
});

test("missing model offers an explicit download with size, progress and cancellation", async () => {
  status.mockResolvedValue({ state: "missing", detail: "모델 없음" });
  install.mockResolvedValue(downloading);
  cancel.mockResolvedValue({ state: "missing", detail: "취소됨" });
  await render();
  expect(container.textContent).toContain("12GB");
  expect(install).not.toHaveBeenCalled();
  await act(async () => button("설치·다운로드").click());
  expect(install).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("12/56");
  expect(container.querySelector("progress")?.getAttribute("value")).not.toBeNull();
  await act(async () => button("설치 취소").click());
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("취소됨");
});

test("a failed download can be retried without opening a terminal", async () => {
  status.mockResolvedValue({ state: "error", detail: "네트워크 오류" });
  install.mockResolvedValue(downloading);
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("네트워크 오류");
  await act(async () => button("다시 시도").click());
  expect(install).toHaveBeenCalledTimes(1);
});

test("ready models do not show setup prompts in writing panels", async () => {
  status.mockResolvedValue({ state: "ready", detail: "준비 완료" });
  await render(true);
  expect(container.textContent).toBe("");
  expect(install).not.toHaveBeenCalled();
});

test("an existing download remains visible after reopening the panel", async () => {
  status.mockResolvedValue(downloading);
  await render(true);
  expect(container.textContent).toContain("12/56");
  expect(button("설치 취소")).toBeDefined();
  expect(install).not.toHaveBeenCalled();
});
