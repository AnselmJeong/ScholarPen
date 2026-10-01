import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CodexStatus } from "../../../shared/codex";
import type { LLMProvider } from "../../../shared/rpc-types";

const dom = new Window();
const keys = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true,
  value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { StatusBar } = await import("./StatusBar");
const status = spyOn(rpc, "getCodexStatus");
const connected: CodexStatus = { state: "connected", ordinaryUsageAllowed: true, quotas: [] };
let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function render(provider: LLMProvider = "codex", model = "gpt-6.1-sol", ollamaConnected = false) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(<StatusBar sidebarAgentProvider={provider} sidebarAgentModel={model}
    ollamaStatus={{ connected: ollamaConnected, models: ["ollama-model"], activeModel: "ollama-model" }}
    wordCount={123} onToggleAI={() => {}} />));
}
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); status.mockReset(); });
afterAll(() => {
  status.mockRestore();
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  dom.happyDOM.abort();
});

test("Codex uses its own connection state and never labels a GPT subscription as Ollama", async () => {
  status.mockResolvedValue(connected);
  await render();
  expect(container!.textContent).toContain("Codex (ChatGPT) connected");
  expect(container!.textContent).toContain("Model: gpt-6.1-sol");
  expect(container!.textContent).not.toContain("Ollama");
  status.mockResolvedValue({ ...connected, state: "signedOut" });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container!.textContent).toContain("Codex (ChatGPT) disconnected");
});

test("Codex reports pending, signing-in, unavailable and failed connections", async () => {
  status.mockImplementationOnce(() => new Promise(() => {}));
  await render();
  expect(container!.textContent).toContain("Codex (ChatGPT) checking");
  for (const [state, label] of [["signingIn", "signing in"], ["unavailable", "unavailable"], ["error", "error"]] as const) {
    await render("ollama");
    status.mockResolvedValue({ ...connected, state });
    await render();
    expect(container!.textContent).toContain(`Codex (ChatGPT) ${label}`);
  }
});

test("late responses from a previous provider selection cannot overwrite the current status", async () => {
  let resolveOld!: (s: CodexStatus) => void;
  status.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await render();
  await render("ollama", "ollama-model", true);
  expect(container!.textContent).toContain("Ollama connected");
  status.mockResolvedValue({ ...connected, state: "signedOut" });
  await render("codex", "", true);
  await act(async () => resolveOld(connected));
  expect(container!.textContent).toContain("Codex (ChatGPT) disconnected");
  expect(container!.textContent).toContain("Model: Codex default");
});

test("other providers do not poll Codex and retain their labels", async () => {
  for (const [provider, label] of [["ollama", "Ollama disconnected"], ["openai", "OpenAI connected"], ["anthropic", "Claude connected"], ["deepseek", "DeepSeek connected"]] as const) {
    await render(provider);
    expect(container!.textContent).toContain(label);
  }
  expect(status).not.toHaveBeenCalled();
});
