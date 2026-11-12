import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WritingPreferences } from "../../../shared/writing-preferences";
const dom = new Window({ url: "http://localhost" });
const keys = ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { WritingPreferencesPanel } = await import("./WritingPreferencesPanel");
const get = spyOn(rpc, "getWritingPreferences"), save = spyOn(rpc, "saveWritingPreferences");
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); get.mockReset(); save.mockReset(); });
afterAll(() => { get.mockRestore(); save.mockRestore(); for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key); void dom.happyDOM.abort(); });
async function render() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<WritingPreferencesPanel />));
}
test("punctuation controls save independently without an extension or project", async () => {
  let value: WritingPreferences = { version: 1, revision: 0, punctuation: { emDash: "avoid", semicolon: "avoid" } };
  get.mockImplementation(async () => value);
  save.mockImplementation(async (revision, punctuation) => { value = { version: 1, punctuation, revision: revision + 1 }; return value; });
  await render();
  const selects = container.querySelectorAll<HTMLSelectElement>("select");
  await act(async () => { selects[0]!.value = "allow"; selects[0]!.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(value.punctuation).toEqual({ emDash: "allow", semicolon: "avoid" });
  expect(selects[1]!.value).toBe("avoid");
  await act(async () => { selects[1]!.value = "allow"; selects[1]!.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(value.punctuation).toEqual({ emDash: "allow", semicolon: "allow" });
  expect(save.mock.calls[1]![0]).toBe(1);
});
test("stale preference edits display the conflict and reload the saved setting", async () => {
  get.mockResolvedValueOnce({ version: 1, revision: 0, punctuation: { emDash: "avoid", semicolon: "avoid" } });
  get.mockResolvedValue({ version: 1, revision: 1, punctuation: { emDash: "avoid", semicolon: "allow" } });
  save.mockRejectedValue(new Error("설정이 변경되었습니다. 새로고침하세요."));
  await render();
  const selects = container.querySelectorAll<HTMLSelectElement>("select");
  await act(async () => { selects[0]!.value = "allow"; selects[0]!.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("설정이 변경되었습니다");
  expect(selects[0]!.value).toBe("avoid"); expect(selects[1]!.value).toBe("allow");
  expect(selects[0]!.disabled).toBeFalse();
});
