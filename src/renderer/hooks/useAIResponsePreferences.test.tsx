import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAIResponsePreferences } from "./useAIResponsePreferences";

const dom = new Window({ url: "http://localhost" });
const keys = ["window", "document", "navigator", "HTMLElement", "Node", "Event", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true,
  value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });

const storageKey = "scholarpen.ai-response-preferences";
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let controls: ReturnType<typeof useAIResponsePreferences>;

function Owner({ session, sidebarOpen = true }: { session: string; sidebarOpen?: boolean }) {
  controls = useAIResponsePreferences();
  return sidebarOpen ? <output key={session}>{JSON.stringify(controls.preferences)}</output> : null;
}

async function render(session = "chat", sidebarOpen = true) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => { root!.render(<Owner session={session} sidebarOpen={sidebarOpen} />); });
}

async function unmount() {
  await act(async () => { root?.unmount(); });
  root = undefined;
  container?.remove();
}

afterEach(async () => {
  await unmount();
  dom.localStorage.clear();
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

test("user choices survive session replacement, sidebar hiding, and application remount", async () => {
  await render();
  expect(controls.preferences).toEqual({ searchEnabled: false, thinkingLevel: "none" });
  await act(async () => {
    controls.setSearchEnabled(true);
    controls.setThinkingLevel("high");
  });
  for (const session of ["validate", "deepen", "new-chat", "history", "new-model", "new-project"]) {
    await render(session);
    expect(controls.preferences).toEqual({ searchEnabled: true, thinkingLevel: "high" });
  }
  await render("closed", false);
  await render("reopened");
  expect(controls.preferences).toEqual({ searchEnabled: true, thinkingLevel: "high" });
  await unmount();
  await render("restart");
  expect(controls.preferences).toEqual({ searchEnabled: true, thinkingLevel: "high" });
});

test("explicit off/none choices replace saved settings and survive restart", async () => {
  localStorage.setItem(storageKey, JSON.stringify({ searchEnabled: true, thinkingLevel: "medium" }));
  await render();
  expect(controls.preferences).toEqual({ searchEnabled: true, thinkingLevel: "medium" });
  await act(async () => { controls.setSearchEnabled(false); controls.setThinkingLevel("none"); });
  await unmount();
  await render();
  expect(controls.preferences).toEqual({ searchEnabled: false, thinkingLevel: "none" });
});

test("invalid saved options use defaults without discarding a valid option", async () => {
  localStorage.setItem(storageKey, JSON.stringify({ searchEnabled: true, thinkingLevel: "invalid" }));
  await render();
  expect(controls.preferences).toEqual({ searchEnabled: true, thinkingLevel: "none" });
  await unmount();
  localStorage.setItem(storageKey, "invalid JSON");
  await render();
  expect(controls.preferences).toEqual({ searchEnabled: false, thinkingLevel: "none" });
});

test("unavailable storage does not prevent updating preferences in memory", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage unavailable"); } });
  try {
    await render();
    await act(async () => { controls.setSearchEnabled(true); controls.setThinkingLevel("low"); });
    await render("deepen");
    expect(controls.preferences).toEqual({ searchEnabled: true, thinkingLevel: "low" });
  } finally {
    await unmount();
    Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});
