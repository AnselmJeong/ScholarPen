import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClaudeStatus } from "../../../shared/claude";

import { buttonByText, chooseOption, installDom } from "../../test-support/dom";
const env = installDom();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { ClaudeConnection } = await import("./ClaudeConnection");
const status = spyOn(rpc, "getClaudeStatus");
const login = spyOn(rpc, "loginClaude");
const logout = spyOn(rpc, "logoutClaude");
const cancel = spyOn(rpc, "cancelClaudeLogin");
const changed = mock((_model: string) => {});
let root: Root | undefined;
let container: HTMLDivElement;
const signedOut: ClaudeStatus = { state: "signedOut" };
const connected: ClaudeStatus = { state: "connected", email: "test@example.com", plan: "pro" };
async function render() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<ClaudeConnection model="" onModelChange={changed} />));
}
function button(label: string) { return buttonByText(container, label)!; }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  for (const spy of [status, login, logout, cancel, changed]) spy.mockReset();
});
afterAll(() => {
  for (const spy of [status, login, logout, cancel]) spy.mockRestore();
  env.restore();
});

test("starts and cancels official Claude sign-in with no API key field", async () => {
  status.mockResolvedValue(signedOut); login.mockResolvedValue(); cancel.mockResolvedValue();
  await render();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  status.mockResolvedValue({ state: "signingIn" });
  await act(async () => button("Claude로 로그인").click());
  expect(login).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("브라우저에서 Claude 로그인을 완료");
  status.mockResolvedValue(signedOut);
  await act(async () => button("로그인 취소").click());
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("shows account, CLI version, model choice and observed quota without claiming a live balance", async () => {
  status.mockResolvedValue({ ...connected, cliVersion: "2.1.273", quota: { status: "allowed_warning", utilization: 0.85, resetsAt: 2_000_000_000, checkedAt: Date.now() } });
  await render();
  expect(container.textContent).toContain("test@example.com");
  expect(container.textContent).toContain("2.1.273");
  expect(container.textContent).toContain("마지막 응답의 한도 상태");
  expect(container.textContent).toContain("85% 사용");
  await chooseOption(container, "Sidebar Agent Model", "opus", act);
  expect(changed).toHaveBeenCalledWith("opus");
});

test("quota exhaustion does not switch models, authenticate or select paid billing", async () => {
  status.mockResolvedValue({ ...connected, quota: { status: "rejected", checkedAt: Date.now() } });
  await render();
  expect(container.textContent).toContain("한도 도달");
  expect(container.textContent).toContain("유료 API로 자동 전환하지 않습니다");
  expect(changed).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled();
});

test("missing CLI and status failures stay actionable", async () => {
  status.mockResolvedValue({ state: "unavailable", error: "CLI missing" });
  await render();
  expect(button("Claude로 로그인").getAttribute("aria-disabled")).toBe("true");
  expect(button("설치 안내")).toBeDefined();
  status.mockRejectedValue(new Error("connection lost"));
  await act(async () => button("새로고침").click());
  expect(container.textContent).toContain("connection lost");
});
