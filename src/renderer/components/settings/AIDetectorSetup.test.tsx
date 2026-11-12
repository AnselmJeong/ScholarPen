import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AIDetectorStatus } from "../../../shared/ai-detector-setup";
import { buttonByText, installDom } from "../../test-support/dom";
const env = installDom();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { AIDetectorSetup } = await import("../../../plugins/ai-writing-score/ui/AIDetectorSetup");
const status = spyOn(rpc, "getAIDetectorStatus");
const install = spyOn(rpc, "installAIDetector");
const cancel = spyOn(rpc, "cancelAIDetectorInstall");
let root: Root | undefined;
let container: HTMLDivElement;
async function render(compact = false) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<AIDetectorSetup compact={compact} />));
}
const button = (label: string) => buttonByText(container, label)!;
const downloading: AIDetectorStatus = { state: "installing", phase: "models", detail: "Downloading", progress: { kind: "files", completed: 12, total: 56 } };
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  for (const spy of [status, install, cancel]) spy.mockReset();
});
afterAll(() => {
  for (const spy of [status, install, cancel]) spy.mockRestore();
  env.restore();
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
