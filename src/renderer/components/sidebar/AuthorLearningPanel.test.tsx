import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
const dom = new Window({ url: "http://localhost" });
const keys = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { AuthorLearningPanel } = await import("./AuthorLearningPanel");
const get = spyOn(rpc, "getAuthorLearning"), status = spyOn(rpc, "getProjectMemoryStatus"), dismiss = spyOn(rpc, "dismissAuthorPreference");
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); [get, status, dismiss].forEach(s => s.mockReset()); });
afterAll(() => { [get, status, dismiss].forEach(s => s.mockRestore()); for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key); void dom.happyDOM.abort(); });

test("Project learning displays observed evidence, actual bank counts and removes a mistaken interpretation", async () => {
  const view = { state: "ready" as const, observations: [{ id: "o1", kind: "direct-edit" as const, filename: "chapter1", blockId: "p1", before: "It is important to note that A.", after: "A.", direction: "", observedAt: 1 }], preferences: [{ id: "pref-1", rule: "도입구를 생략한다", scope: "영문", evidenceIds: ["o1"] }] };
  get.mockResolvedValue(view); status.mockResolvedValue({ state: "ready", bankId: "bank", url: "http://localhost", memories: 8, documents: 3, pending: 1 });
  dismiss.mockResolvedValue({ ...view, preferences: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<AuthorLearningPanel projectPath="/project" />));
  expect(container.textContent).toContain("도입구를 생략한다"); expect(container.textContent).toContain("Hindsight 기억 8건");
  expect(container.textContent).toContain("이전: It is important");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="이 학습 제외"]')!.click());
  expect(dismiss).toHaveBeenCalledWith("/project", "pref-1"); expect(container.textContent).not.toContain("도입구를 생략한다");
  expect(container.textContent).toContain("아직 반복된 취향");
});
