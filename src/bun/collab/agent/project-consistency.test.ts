import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OllamaMessage } from "../../../shared/rpc-types";
import { documentStructure, type ProjectDocument } from "../project-documents";
import { brokenReferences, duplicatePassages, parseContradictions, terminologyIssues } from "./project-consistency";
import { refreshManuscriptMap } from "./manuscript-map";
import { ProjectWriting } from "../project-writing";
import type { CollabRegistry } from "../registry";
import type { ManuscriptMap } from "../../../shared/manuscript-map";

const repeated = "The intervention reduced depressive symptoms across all three cohorts while adverse events remained rare and mild, " +
  "which suggests that the treatment is both effective and well tolerated in routine clinical practice settings today.";
const paragraph = (id: string, text: string, extra: object = {}) => ({ id, type: "paragraph", content: [{ type: "text", text }], ...extra });

function project(): ProjectDocument[] {
  return [
    documentStructure("intro.scholarpen.json", [
      { id: "h1", type: "heading", props: { level: 1, label: "sec-intro" }, content: [{ type: "text", text: "Introduction" }] },
      paragraph("i1", repeated),
      paragraph("i2", "We enrolled 120 patients. See ", { content: [{ type: "text", text: "We enrolled 120 patients. See " },
        { type: "crossReference", props: { label: "fig-missing" } }, { type: "text", text: " and " }, { type: "crossReference", props: { label: "sec-methods" } }] }),
    ]),
    documentStructure("methods.scholarpen.json", [
      { id: "h2", type: "heading", props: { level: 1, label: "sec-methods" }, content: [{ type: "text", text: "Methods" }] },
      paragraph("m1", "We enrolled 150 patients using MRI scans."),
      paragraph("m2", `As noted, ${repeated}`),
    ]),
  ];
}

test("documents expose paragraphs, cross-references and labels", () => {
  const [intro] = project();
  expect(intro.labels).toEqual(["sec-intro"]);
  expect(intro.references).toEqual([{ blockId: "i2", label: "fig-missing" }, { blockId: "i2", label: "sec-methods" }]);
  expect(intro.text).toContain("We enrolled 120 patients. See @fig-missing and @sec-methods");
});

test("references are checked against labels in every document", () => {
  expect(brokenReferences(project())).toEqual([expect.objectContaining({ kind: "broken-reference", filename: "intro.scholarpen.json", blockId: "i2", quote: "@fig-missing" })]);
});

test("a passage repeated in another document is reported once, at the later copy", () => {
  const issues = duplicatePassages(project());
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ kind: "duplicate", filename: "methods.scholarpen.json", blockId: "m2", related: { filename: "intro.scholarpen.json" } });
});

test("the glossary is enforced in every document", () => {
  const issues = terminologyIssues(project(), { entries: [{ term: "magnetic resonance imaging", abbreviation: "MRI" }] });
  expect(issues).toEqual([expect.objectContaining({ kind: "terminology", filename: "methods.scholarpen.json", blockId: "m1", quote: "MRI" })]);
});

const map: ManuscriptMap = { documents: {
  "intro.scholarpen.json": { filename: "intro.scholarpen.json", hash: "h", title: "Intro", summary: "", claims: [], terms: [], updatedAt: 1,
    numbers: [{ value: "120", context: "sample size", quote: "We enrolled 120 patients." }] },
  "methods.scholarpen.json": { filename: "methods.scholarpen.json", hash: "h", title: "Methods", summary: "", claims: [], terms: [], updatedAt: 1,
    numbers: [{ value: "150", context: "sample size", quote: "We enrolled 150 patients" }] },
} };

test("contradictions point at both places, and unknown item ids are ignored", () => {
  const issues = parseContradictions(JSON.stringify({ issues: [{ a: "D1.N1", b: "D2.N1", comment: "Sample sizes differ." }, { a: "D9.C1", b: "D1.N1", comment: "x" }] }), map, project());
  expect(issues).toEqual([
    expect.objectContaining({ kind: "contradiction", filename: "intro.scholarpen.json", blockId: "i2", related: { filename: "methods.scholarpen.json", quote: "We enrolled 150 patients" } }),
    expect.objectContaining({ kind: "contradiction", filename: "methods.scholarpen.json", blockId: "m1" }),
  ]);
});

test("the map is refreshed only for changed documents and forgets deleted ones", async () => {
  let stored: ManuscriptMap = { documents: { "gone.scholarpen.json": { ...map.documents["intro.scholarpen.json"], filename: "gone.scholarpen.json" } } };
  const store = { read: async () => stored, update: async (change: (m: ManuscriptMap) => ManuscriptMap) => (stored = change(stored)) };
  const calls: string[] = [];
  const complete = async (messages: OllamaMessage[]) => {
    calls.push(String(messages[1].content).match(/filename="([^"]+)"/)![1]);
    return JSON.stringify({ title: "T", summary: "S", numbers: [{ value: "150", context: "n", quote: "We enrolled 150 patients" }] });
  };
  const documents = project();
  await refreshManuscriptMap(documents, store, complete, new AbortController().signal);
  expect(calls).toEqual(["intro.scholarpen.json", "methods.scholarpen.json"]);
  expect(Object.keys(stored.documents)).toEqual(["intro.scholarpen.json", "methods.scholarpen.json"]);
  expect(stored.documents["intro.scholarpen.json"].numbers).toEqual([]); // That quote is not in the introduction.
  expect(stored.documents["methods.scholarpen.json"].numbers).toHaveLength(1);
  await refreshManuscriptMap(documents, store, complete, new AbortController().signal);
  expect(calls).toHaveLength(2);
});

test("the whole check writes a report, and a failed model call is reported instead of hiding the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "scholarpen-consistency-"));
  try {
    const writing = new ProjectWriting({ list: () => [] } as unknown as CollabRegistry, {
      resolveProject: async path => path, loadDocuments: async () => project(),
      complete: async () => { throw new Error("model offline"); },
    });
    const report = await writing.checkConsistency(root, new AbortController().signal);
    expect(report.issues.map(issue => issue.kind).sort()).toEqual(["broken-reference", "duplicate", "terminology"]);
    expect(report.skipped.join(" ")).toContain("model offline");
    expect(JSON.parse(await readFile(join(root, ".scholarpen", "consistency-report.json"), "utf8")).issues).toHaveLength(3);
    expect((await writing.saveGlossary(root, { entries: [{ term: "x", abbreviation: "XY" }] })).entries).toEqual([{ term: "x", abbreviation: "XY" }]);
    expect((await writing.guide(root)).glossary.entries).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
