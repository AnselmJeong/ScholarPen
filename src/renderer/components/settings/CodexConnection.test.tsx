import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CodexStatus } from "../../../shared/codex";

const dom = new Window();
const keys = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
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
function button(label: string) { return Array.from(container.querySelectorAll("button")).find(b => b.textContent === label)!; }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  for (const spy of [status, models, login, logout, cancel, changed]) spy.mockReset();
});
afterAll(() => {
  for (const spy of [status, models, login, logout, cancel]) spy.mockRestore();
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  dom.happyDOM.abort();
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
  const select = container.querySelector("select")!;
  await act(async () => { select.value = "available-model"; select.dispatchEvent(new Event("change", { bubbles: true })); });
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
  expect(button("ChatGPT로 로그인").disabled).toBeTrue();
  expect(button("CLI 설치 안내")).toBeDefined();
  status.mockRejectedValue(new Error("connection lost"));
  await act(async () => button("새로고침").click());
  expect(container.textContent).toContain("connection lost");
});
