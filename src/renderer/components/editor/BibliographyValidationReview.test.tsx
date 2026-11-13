import { afterAll, afterEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BibliographyMaintenanceResult } from "@shared/rpc-types";
import { installDom } from "../../test-support/dom";
const env = installDom();
const { BibliographyValidationReview, INTEGRITY_REPORT_FILENAME } = await import("./BibliographyValidationReview");

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
});
afterAll(() => {
  env.restore();
});

const result: BibliographyMaintenanceResult = {
  bibtex: "",
  removedUnused: 0,
  scannedDocuments: 2,
  usedEntries: 3,
  missingCitekeys: ["ghost2020"],
  backupPath: null,
  validations: [
    { citekey: "clean2020", entryType: "article", status: "valid", fields: [] },
    { citekey: "eoc2019", entryType: "article", status: "valid", fields: [],
      integrityNotices: [{ kind: "expression_of_concern", source: "crossref" }] },
    { citekey: "gone2018", entryType: "article", status: "valid", fields: [],
      integrityNotices: [{ kind: "retracted", source: "crossref", noticeDoi: "10.1/notice", date: "2021-02" }] },
  ],
  vagueAttributions: [
    { filename: "intro.scholarpen.json", phrase: "Studies show", excerpt: "Studies show that X." },
    { filename: "intro.scholarpen.json", phrase: "한 연구에 따르면", excerpt: "한 연구에 따르면 Y이다." },
  ],
};

async function render(onExportReport?: (filename: string, csv: string) => Promise<string>) {
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<BibliographyValidationReview result={result} onExportReport={onExportReport} />));
}

test("shows retraction and concern badges with the retracted entry first", async () => {
  await render();
  const text = container.textContent ?? "";
  expect(text).toContain("철회 1개");
  expect(text).toContain("우려 표명 1개");
  expect(text).toContain("출처 불명확 서술 2건");
  expect(text).toContain("ghost2020");
  expect(text.indexOf("gone2018")).toBeLessThan(text.indexOf("eoc2019"));
  expect(text.indexOf("eoc2019")).toBeLessThan(text.indexOf("clean2020"));
  const link = container.querySelector('a[href="https://doi.org/10.1/notice"]');
  expect(link).not.toBeNull();
  expect(container.querySelector("mark")?.textContent).toBe("Studies show");
  expect(text).not.toContain("리포트 내보내기");
});

test("exports the CSV report and shows the saved path", async () => {
  const exportReport = mock(async (_filename: string, _csv: string) => "/p/exports/reference-integrity-report.csv");
  await render(exportReport);
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("리포트 내보내기"))!;
  await act(async () => { button.click(); });
  expect(exportReport).toHaveBeenCalledTimes(1);
  const [filename, csv] = exportReport.mock.calls[0]!;
  expect(filename).toBe(INTEGRITY_REPORT_FILENAME);
  expect(csv).toContain("notice,gone2018,retracted");
  expect(container.textContent).toContain("저장됨: /p/exports/reference-integrity-report.csv");
});

test("reports an export failure", async () => {
  await render(async () => { throw new Error("disk full"); });
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("리포트 내보내기"))!;
  await act(async () => { button.click(); });
  expect(container.textContent).toContain("disk full");
});
