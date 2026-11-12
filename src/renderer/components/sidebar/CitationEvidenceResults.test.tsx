import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CitationSearchResult } from "../../../shared/citation-evidence";

import { controlByLabel, installDom, isDisabled } from "../../test-support/dom";
const env = installDom();
const dom = env.dom;
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { CitationEvidenceResults } = await import("./CitationEvidenceResults");
const resolve = spyOn(rpc, "resolveDOI"), merge = spyOn(rpc, "mergeBibtex"), load = spyOn(rpc, "loadBibtex");
const retry = mock((_claims: string[], _selected: string) => {});
let root: Root | undefined;
let container: HTMLDivElement;
const result: CitationSearchResult = { version: 1, selectedText: "선택한 원문", claims: ["Depression may affect recall."], notices: [], fallback: [], evidence: [{
  claimIndex: 0, side: "supports", evidence: "The group recalled more negative words.", context: "Participants were adults. The group recalled more negative words.", section: "RESULTS", confidence: 0.91, weight: 0.8,
  paper: { id: "PMC123", doi: "10.1234/memory", pmid: "123", title: "Memory evidence", authors: ["First Author"], authorsTruncated: true, year: 2025, journal: "Test Journal", source: "pmc", design: "cohort", retracted: false, expressionOfConcern: false },
}] };
async function render(value = result, busy = false) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CitationEvidenceResults result={value} projectPath="/project" onRetry={retry} busy={busy} />));
}
function button(label: string) { return Array.from(container.querySelectorAll("button")).find(button => button.textContent === label)!; }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  [resolve, merge, load, retry].forEach(spy => spy.mockReset());
});
afterAll(() => {
  [resolve, merge, load].forEach(spy => spy.mockRestore());
  env.restore();
});

test("shows exact passages, surrounding context, partial authors and separate judgments; retries explicit claims", async () => {
  await render({ ...result, evidence: [...result.evidence, { ...result.evidence[0], side: "refutes", evidence: "There was no difference." }] });
  expect(container.querySelector('[aria-label="지지 근거"]')?.textContent).toContain("The group recalled more negative words.");
  expect(container.querySelector('[aria-label="반박 근거"]')?.textContent).toContain("There was no difference.");
  expect(container.textContent).toContain("First Author et al.");
  expect(container.textContent).toContain("Participants were adults.");
  expect(controlByLabel<HTMLTextAreaElement>(container, "검색 주장 1")?.value).toBe(result.claims[0]);
  await act(async () => button("수정한 주장으로 재검색").click());
  expect(retry).toHaveBeenCalledWith(result.claims, result.selectedText);
});

test("does not allow a retracted paper to be added as a recommended citation", async () => {
  await render({ ...result, evidence: [{ ...result.evidence[0], paper: { ...result.evidence[0].paper, retracted: true } }] });
  expect(container.querySelector('[aria-label="지지 근거"]')?.textContent).not.toContain("Memory evidence");
  expect(container.textContent).toContain("철회된 논문");
  expect(isDisabled(button("참고문헌에 추가"))).toBeTrue();
});

test("resolves full metadata, safely merges bibliography and returns an existing DOI's citekey", async () => {
  resolve.mockResolvedValue({ doi: "10.1234/memory", title: "Memory evidence", authors: ["First Author", "Second Author"], year: 2025, citekey: "newkey", bibtex: "@article{newkey, doi={10.1234/memory}, title={Memory evidence}}" });
  merge.mockResolvedValue({ bibtex: "", addedEntries: 0, skippedDuplicates: [{ citekey: "newkey", duplicateOfCitekey: "existingkey" }], backupPath: null });
  load.mockResolvedValue("@article{existingkey, doi={10.1234/memory}, title={Memory evidence}}\n@article{unrelated, title={Keep me}}");
  await render();
  await act(async () => button("참고문헌에 추가").click());
  expect(resolve).toHaveBeenCalledWith("10.1234/memory");
  expect(merge).toHaveBeenCalledWith("/project", expect.stringContaining("@article{newkey"));
  expect(load).toHaveBeenCalledWith("/project");
  expect(container.textContent).toContain("참고문헌에 저장됨");
  expect(button("인용 키 복사")).toBeDefined();
});

test("failed DOI resolution never writes a bibliography or reports success", async () => {
  resolve.mockRejectedValue(new Error("DOI lookup failed"));
  await render();
  await act(async () => button("참고문헌에 추가").click());
  expect(merge).not.toHaveBeenCalled();
  expect(container.textContent).toContain("DOI lookup failed");
  expect(container.textContent).not.toContain("참고문헌에 저장됨");
});

test("invalid edited claim length is actionable and does not dispatch a search", async () => {
  await render({ ...result, claims: ["a".repeat(591)] });
  await act(async () => button("수정한 주장으로 재검색").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("590자");
  expect(retry).not.toHaveBeenCalled();
});

test("retry is disabled while a search is already running", async () => {
  await render(result, true);
  expect(isDisabled(button("수정한 주장으로 재검색"))).toBeTrue();
});
