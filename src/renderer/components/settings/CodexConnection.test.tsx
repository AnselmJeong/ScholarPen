import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CodexStatus } from "../../../shared/codex";

import { buttonByText, chooseOption, installDom, optionTexts } from "../../test-support/dom";
const env = installDom();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { CodexConnection } = await import("./CodexConnection");
const status = spyOn(rpc, "getCodexStatus");
const models = spyOn(rpc, "listProviderModels");
const login = spyOn(rpc, "loginCodex");
const logout = spyOn(rpc, "logoutCodex");
const cancel = spyOn(rpc, "cancelCodexLogin");
const changed = mock((_model: string) => {});
let root: Root | undefined;
let container: HTMLDivElement;
const signedOut: CodexStatus = { state: "signedOut", ordinaryUsageAllowed: null, quotas: [] };
const connected: CodexStatus = { state: "connected", email: "test@example.com", plan: "plus", ordinaryUsageAllowed: true, quotas: [] };
async function render() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CodexConnection model="" onModelChange={changed} />));
}
function button(label: string) { return buttonByText(container, label)!; }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  for (const spy of [status, models, login, logout, cancel, changed]) spy.mockReset();
});
afterAll(() => {
  for (const spy of [status, models, login, logout, cancel]) spy.mockRestore();
  env.restore();
});

test("starts and cancels ChatGPT login without showing any API-key field", async () => {
  status.mockResolvedValue(signedOut); login.mockResolvedValue(); cancel.mockResolvedValue();
  await render();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  status.mockResolvedValue({ ...signedOut, state: "signingIn" });
  await act(async () => button("ChatGPT로 로그인").click());
  expect(login).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("브라우저에서 ChatGPT 로그인을 완료");
  status.mockResolvedValue(signedOut);
  await act(async () => button("로그인 취소").click());
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("shows account, model selection, remaining quota, reset time, and logout", async () => {
  status.mockResolvedValue({ ...connected, quotas: [{ id: "codex", name: "Codex", model: null, primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: null }] });
  models.mockResolvedValue(["available-model"]); logout.mockResolvedValue();
  await render();
  expect(container.textContent).toContain("75% 남음");
  expect(container.textContent).toContain("초기화");
  expect(container.textContent).toContain("test@example.com");
  await chooseOption(container, "Sidebar Agent Model", "available-model", act);
  expect(changed).toHaveBeenCalledWith("available-model");
  status.mockResolvedValue(signedOut);
  await act(async () => button("로그아웃").click());
  expect(logout).toHaveBeenCalledTimes(1);
});

test("reports quota exhaustion and never initiates login or changes provider automatically", async () => {
  status.mockResolvedValue({ ...connected, ordinaryUsageAllowed: false }); models.mockResolvedValue([]);
  await render();
  expect(container.textContent).toContain("한도에 도달");
  expect(container.textContent).toContain("유료 API로 전환하지 않았습니다");
  expect(login).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

test("shows actionable missing-CLI and connection failures", async () => {
  status.mockResolvedValue({ ...signedOut, state: "unavailable", error: "CLI missing" });
  await render();
  expect(button("ChatGPT로 로그인").getAttribute("aria-disabled")).toBe("true");
  expect(button("CLI 설치 안내")).toBeDefined();
  status.mockRejectedValue(new Error("connection lost"));
  await act(async () => button("새로고침").click());
  expect(container.textContent).toContain("connection lost");
});

test("manual refresh reconnects and loads new models, showing the running CLI version", async () => {
  status.mockResolvedValue({ ...connected, cliPath: "/test/codex", cliVersion: "0.154.0" });
  models.mockResolvedValue(["gpt-5.6-sol"]);
  await render();
  status.mockResolvedValue({ ...connected, cliPath: "/test/codex", cliVersion: "0.160.0" });
  models.mockResolvedValue(["gpt-6.1-sol", "gpt-5.6-sol"]);
  await act(async () => button("새로고침").click());
  expect(status).toHaveBeenLastCalledWith(true);
  expect(container.textContent).toContain("Codex CLI 0.160.0");
  expect(await optionTexts(container, "Sidebar Agent Model", act)).toContain("gpt-6.1-sol");
  expect(changed).not.toHaveBeenCalled();
  expect(logout).not.toHaveBeenCalled();
});
