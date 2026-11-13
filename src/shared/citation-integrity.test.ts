import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BibliographyMaintenanceResult } from "./rpc-types";
import {
  buildIntegrityReportCsv,
  documentParagraphTexts,
  findVagueAttributions,
  integrityNoticesFromCrossref,
  isEditorialNoticeRecord,
  summarizeIntegrity,
} from "./citation-integrity";
import { BibliographyRepository } from "../plugins/bibliography/main/repository";

describe("Crossref integrity notices", () => {
  test("maps retraction and expression-of-concern relations and ignores corrections", () => {
    const notices = integrityNoticesFromCrossref([
      { DOI: "10.1/EOC", type: "expression_of_concern", updated: { "date-parts": [[2021, 3]] } },
      { DOI: "10.1/corr", type: "correction" },
      { DOI: "10.1/RET", type: "retraction", updated: { "date-parts": [[2022, 1, 5]] } },
      { DOI: "10.1/ret", type: "retraction" },
    ]);
    expect(notices).toEqual([
      { kind: "retracted", source: "crossref", noticeDoi: "10.1/ret", date: "2022-01-05" },
      { kind: "expression_of_concern", source: "crossref", noticeDoi: "10.1/eoc", date: "2021-03" },
    ]);
  });

  test("returns nothing for clean works", () => {
    expect(integrityNoticesFromCrossref(undefined)).toEqual([]);
    expect(integrityNoticesFromCrossref([{ type: "erratum" }])).toEqual([]);
  });

  test("recognizes a record that is itself a retraction notice", () => {
    expect(isEditorialNoticeRecord([{ DOI: "10.1/a", type: "retraction" }])).toBe(true);
    expect(isEditorialNoticeRecord([{ DOI: "10.1/a", type: "correction" }])).toBe(false);
    expect(isEditorialNoticeRecord(undefined)).toBe(false);
  });
});

describe("vague attributions", () => {
  test("flags English and Korean attributions without a citation", () => {
    const found = findVagueAttributions(
      "A recent study found that sleep improves memory. Studies show this effect is robust [@walker2017]. "
      + "한 연구에 따르면 운동은 우울을 줄인다. 선행연구(김, 2020)에 따르면 효과는 작다.",
    );
    expect(found.map((item) => item.phrase)).toEqual(["A recent study found", "한 연구에 따르면"]);
    expect(found[0]!.excerpt).toBe("A recent study found that sleep improves memory.");
  });

  test("treats numeric, pandoc and author-year markers as citations", () => {
    expect(findVagueAttributions("Research has shown large effects [3, 4].")).toEqual([]);
    expect(findVagueAttributions("Research has shown large effects (Smith et al., 2019).")).toEqual([]);
    expect(findVagueAttributions("As @smith2019 notes, research has shown large effects.")).toEqual([]);
  });

  test("deduplicates repeated sentences and trims long excerpts", () => {
    const sentence = `Evidence suggests ${"x".repeat(400)}.`;
    const found = findVagueAttributions(`${sentence} ${sentence}`);
    expect(found).toHaveLength(1);
    expect(found[0]!.excerpt.length).toBe(240);
  });

  test("reads prose blocks only and serializes inline citations", () => {
    const texts = documentParagraphTexts([
      { type: "heading", content: [{ type: "text", text: "Studies show headings" }] },
      { type: "paragraph", content: [{ type: "text", text: "Research shows X " }, { type: "citation", props: { citekey: "a2020" } }] },
      { type: "figure", props: { caption: "Studies show captions" } },
      { type: "bulletListItem", content: [{ type: "link", content: [{ type: "text", text: "linked" }] }],
        children: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] },
    ]);
    expect(texts).toEqual(["Research shows X [@a2020]", "linked", "nested"]);
  });

  test("the bibliography scan reports attributions per document", async () => {
    const project = await mkdtemp(join(tmpdir(), "scholarpen-integrity-"));
    try {
      await mkdir(join(project, "documents", "ch"), { recursive: true });
      await writeFile(join(project, "documents", "ch", "intro.scholarpen.json"), JSON.stringify([
        { type: "paragraph", content: [{ type: "text", text: "Studies show that X. Y is true " }, { type: "citation", props: { citekey: "y2020" } }] },
      ]));
      const repository = new BibliographyRepository({
        resolveProjectPath: async (path: string) => path,
        writeFileAtomically: async () => {},
      } as never);
      const usage = await repository.scanBibliographyUsage(project);
      expect(usage.usedCitekeys).toEqual(["y2020"]);
      expect(usage.vagueAttributions).toEqual([
        { filename: join("ch", "intro.scholarpen.json"), phrase: "Studies show", excerpt: "Studies show that X." },
      ]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

const result: BibliographyMaintenanceResult = {
  bibtex: "",
  removedUnused: 0,
  scannedDocuments: 1,
  usedEntries: 3,
  missingCitekeys: ["ghost"],
  backupPath: null,
  validations: [
    { citekey: "ok", entryType: "article", status: "valid", fields: [{ field: "title", status: "match" }] },
    {
      citekey: "bad", entryType: "article", status: "changes",
      fields: [{ field: "year", status: "mismatch", current: "2019", canonical: "2020" }],
      integrityNotices: [{ kind: "retracted", source: "crossref", noticeDoi: "10.1/ret" }],
    },
    {
      citekey: "eoc", entryType: "article", status: "valid", fields: [],
      integrityNotices: [{ kind: "expression_of_concern", source: "crossref" }],
    },
  ],
  vagueAttributions: [{ filename: "a.scholarpen.json", phrase: "Studies show", excerpt: "Studies show \"x\", y." }],
};

describe("integrity report", () => {
  test("summarizes counts", () => {
    expect(summarizeIntegrity(result)).toEqual({
      verified: 2, needsReview: 1, unverified: 0, retracted: 1, concern: 1, missing: 1, vague: 1,
    });
  });

  test("writes an escaped CSV with a BOM", () => {
    const csv = buildIntegrityReportCsv(result);
    expect(csv.startsWith("\uFEFFsection,citekey,status,")).toBe(true);
    const lines = csv.trim().split("\r\n");
    expect(lines).toContain("field,bad,mismatch,year,2019,2020,,,,");
    expect(lines).toContain("notice,bad,retracted,,,,10.1/ret,crossref,,");
    expect(lines).toContain("missing_citekey,ghost,missing,,,,,,,");
    expect(lines).toContain('vague_attribution,,unsourced,,Studies show,,,,a.scholarpen.json,"Studies show ""x"", y."');
    expect(lines.some((line) => line.startsWith("field,ok,"))).toBe(false);
  });
});
