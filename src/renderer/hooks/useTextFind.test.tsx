import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTextFind, findTextRanges } from "./useTextFind";

const dom = new Window();
const keys = ["window", "document", "Node", "NodeFilter", "HTMLElement", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
let root: Root | undefined;
let container: HTMLDivElement;
let find: ReturnType<typeof useTextFind>;
function Preview({ text, active = true }: { text: string; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  find = useTextFind(ref, text, active);
  return <div ref={ref}><p>{text}<strong> emphasis</strong> trailing</p></div>;
}
async function render(text: string, active = true) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => { root!.render(<Preview text={text} active={active} />); });
}
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); });
afterAll(() => {
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  dom.happyDOM.abort();
});
test("find keeps React-owned text nodes intact through query, rerender, clear and unmount", async () => {
  await render("alpha alpha");
  const node = container.querySelector("p")!.firstChild;
  await act(async () => find.setQuery("alpha"));
  expect(find.matchCount).toBe(2);
  expect(container.querySelector("p")!.firstChild === node).toBe(true);
  expect(container.querySelector("mark")).toBeNull();
  await act(async () => find.goNext());
  expect(find.currentIdx).toBe(1);
  await render("updated alpha");
  expect(find.matchCount).toBe(1);
  expect(container.textContent).toBe("updated alpha emphasis trailing");
  await act(async () => find.clear());
  expect(find.matchCount).toBe(0);
});
test("handles empty queries, Korean composed/decomposed text and inactive previews", async () => {
  await render("가 각".normalize("NFD"));
  await act(async () => find.setQuery("각"));
  expect(find.matchCount).toBe(1);
  expect(findTextRanges(container, "각")[0].toString()).toBe("각".normalize("NFD"));
  await render("가 각".normalize("NFD"), false);
  expect(find.matchCount).toBe(0);
  await render("가 각".normalize("NFD"), true);
  expect(find.matchCount).toBe(1);
  await act(async () => find.setQuery("   "));
  expect(find.matchCount).toBe(0);
});
