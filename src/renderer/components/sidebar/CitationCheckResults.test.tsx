import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CitationCheckFinding, CitationCheckResult } from "@shared/citation-check";
const dom = new Window();
const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLButtonElement", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "DocumentFragment", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
const { CitationCheckResults } = await import("./CitationCheckResults");

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
});
afterAll(() => {
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  dom.happyDOM.abort();
});

const base: CitationCheckFinding = {
  citekey: "tu2021", sentence: "Cathodal tDCS cures chronic pain.", coCited: [], title: "Manipulating placebo analgesia",
  authors: "Tu et al.", year: "2021", doi: "10.1073/pnas.2101273118", basis: "fulltext",
  pdfRelpath: "resources/articles/tu.pdf", verdict: "overclaim", issue: "population",
  reason: "The paper tested healthy volunteers.", quotes: [{ text: "boost placebo analgesia in healthy participants", page: 7 }],
  suggestion: "Cathodal tDCS boosted placebo analgesia in healthy volunteers.", retracted: false,
};
const result: CitationCheckResult = {
  version: 1, requestId: "req-1", selectedText: "…", notices: ["PDF 색인이 아직 진행 중입니다."], revision: "⟦SP:x:T0:OPEN⟧revised⟦SP:x:T0:CLOSE⟧",
  findings: [
    { ...base, citekey: "ok2020", verdict: "supported", issue: null, suggestion: null, reason: "Matches." },
    base,
    { ...base, citekey: "abs2019", basis: "abstract", pdfRelpath: null, verdict: "unsupported", issue: "off-topic", quotes: [], suggestion: "Cite another source." },
  ],
};

async function mount(onApply = mock((_id: string, _revision: string) => null as string | null), opened: unknown[] = []) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CitationCheckResults result={result} onApplyRevision={onApply} onOpenProjectSource={reference => opened.push(reference)} />));
  return onApply;
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  expect(Boolean(found)).toBe(true);
  return found!;
}

test("lists problems first with their reason, source quote, basis and suggestion", async () => {
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("문제 2 · 지지 1");
  expect(text.indexOf("[@tu2021]")).toBeLessThan(text.indexOf("[@ok2020]"));
  expect(text).toContain("과장");
  expect(text).toContain("대상·모델의 확대 적용");
  expect(text).toContain("오류로 본 이유The paper tested healthy volunteers.");
  expect(text).toContain("“boost placebo analgesia in healthy participants”");
  expect(text).toContain("개선안Cathodal tDCS boosted placebo analgesia in healthy volunteers.");
  expect(text).toContain("원문 PDF 확인");
  expect(text).toContain("초록에서 확인 안 됨");
  expect(text).toContain("초록만 확인 · 확실성 낮음");
  expect(text).toContain("개선 방법Cite another source.");
  expect(text).toContain("PDF 색인이 아직 진행 중입니다.");
});

test("stages the revision once and opens the PDF at a quoted page", async () => {
  const opened: unknown[] = [];
  const onApply = await mount(undefined, opened);
  await act(async () => button("개선안을 문서에 변경 추적으로 표시").click());
  expect(onApply).toHaveBeenCalledWith("req-1", result.revision!);
  expect(button("변경 추적으로 표시됨").disabled).toBe(true);
  await act(async () => button("p. 7").click());
  expect(opened).toEqual([{ relativePath: "resources/articles/tu.pdf", page: 7 }]);
});

test("reports a failed revision without marking it applied", async () => {
  await mount(mock(() => "선택 영역이 변경되었습니다."));
  await act(async () => button("개선안을 문서에 변경 추적으로 표시").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("선택 영역이 변경되었습니다.");
  expect(button("개선안을 문서에 변경 추적으로 표시").disabled).toBe(false);
});
