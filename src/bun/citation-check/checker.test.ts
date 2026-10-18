import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Schema } from "prosemirror-model";
import { parseBibtexEntries } from "../../shared/bibtex-utils";
import { protectSelectionSlice, protectedRewritePreview, restoreProtectedSelection } from "../../shared/ai-text-protection";
import type { AgentStreamParams } from "../../shared/rpc-types";
import type { AgentCompletionRequest } from "../agent/providers";
import type { ExtractedPdf } from "../project-sources/pdf-extractor";
import { checkCitations, parseJudgment, verifyJudgment, type CitationCheckDeps } from "./checker";
import { CitationSourceIndex } from "./source-index";

const projects: string[] = [];
afterEach(async () => {
  await Promise.all(projects.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const filler = (topic: string) => Array.from({ length: 30 }, (_, i) => `The ${topic} observation ${i} was recorded.`).join(" ");

const BIB = `
@article{tu2021manipulating,
  title = {Manipulating placebo analgesia and nocebo hyperalgesia by changing brain excitability},
  author = {Tu, Yiheng and Bi, Yanzhi and Zhang, Lin},
  year = {2021},
  doi = {10.1073/pnas.2101273118}
}
@article{cohen2020placebo,
  title = {Placebo response mitigation with a participant-focused psychoeducational procedure},
  author = {Cohen, Elan A.},
  year = {2020}
}
@article{other2019,
  title = {Sleep spindles in adolescents},
  author = {Other, A.},
  year = {2019},
  doi = {10.1000/other.2019}
}
`;

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*" },
    text: { group: "inline" },
    citation: { inline: true, group: "inline", atom: true, attrs: { citekey: { default: "" }, locator: { default: "" } } },
  },
});

function selection() {
  const cite = (citekey: string) => schema.nodes.citation.create({ citekey });
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [
    schema.text("Cathodal tDCS cures chronic pain in all patients "), cite("tu2021manipulating"),
    schema.text(". Psychoeducation reduced the placebo response "), cite("cohen2020placebo"),
    schema.text(". Sleep spindles grow during adolescence "), cite("other2019"),
    schema.text(". An uncatalogued claim "), cite("missing2000"),
    schema.text("."),
  ])]);
  const slice = doc.slice(0, doc.content.size);
  const protection = protectSelectionSlice(slice, slice.content.textBetween(0, slice.content.size));
  return { protection, selectedText: protectedRewritePreview(protection.protectedText, protection) };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "scholarpen-citation-check-"));
  projects.push(root);
  const pdfs: Record<string, string[]> = {
    "resources/articles/tu2021.pdf": [
      `Manipulating placebo analgesia and nocebo hyperalgesia by changing brain excitability. doi:10.1073/pnas.2101273118 Healthy volunteers received tDCS. ${filler("lead")}`,
      `Results from our task fMRI suggest that cathodal tDCS enhanced brain activations in the vmPFC to boost placebo analgesia in healthy participants. ${filler("results")}`,
    ],
    "resources/articles/2020 - Cohen - Placebo response mitigation with a participant-focused psychoeducational procedure.pdf": [
      `Header. ${filler("cohen lead")}`, `Brief psychoeducation lowered placebo response rates in the PCRS group. ${filler("cohen body")}`,
    ],
  };
  for (const [relpath, pages] of Object.entries(pdfs)) {
    await mkdir(join(root, relpath, ".."), { recursive: true });
    await writeFile(join(root, relpath), JSON.stringify(pages));
  }
  const index = new CitationSourceIndex(root, async (path): Promise<ExtractedPdf> => {
    const pages = JSON.parse(await Bun.file(path).text()) as string[];
    return { pageCount: pages.length, pages: pages.map((content, i) => ({ pageNumber: i + 1, content })) };
  });
  return { root, index };
}

function fakeModel(calls: AgentCompletionRequest[]) {
  return async (request: AgentCompletionRequest): Promise<string> => {
    calls.push(request);
    const system = request.messages[0].content as string;
    const user = request.messages[1].content as string;
    if (system.startsWith("You prepare search queries")) {
      return JSON.stringify({ queries: { "0": ["Cathodal tDCS cures chronic pain in all patients", "tdcs cathodal boost enhance placebo analgesia pain"], "1": ["Psychoeducation reduced placebo response", "psychoeducation placebo response"] } });
    }
    if (system.startsWith("You check whether")) {
      if (user.includes("Manipulating placebo analgesia")) {
        return "```json\n" + JSON.stringify({
          verdict: "overclaim", issue: "population",
          reason: "The paper boosted placebo analgesia in healthy volunteers; it did not treat chronic pain.",
          quotes: [{ passage: "P3", text: "cathodal tDCS enhanced brain activations in the vmPFC to boost placebo analgesia in healthy participants" }],
          suggestion: "Cathodal tDCS boosted placebo analgesia in healthy volunteers.", searchAgain: null,
        }) + "\n```";
      }
      if (user.includes("Placebo response mitigation")) {
        // A quote that is not in the PDF: the verdict must be withheld.
        return JSON.stringify({ verdict: "supported", issue: null, reason: "Supported.", quotes: [{ passage: "P2", text: "Psychoeducation eliminated every placebo response in all trials" }], suggestion: null, searchAgain: null });
      }
      expect(user).toContain("the paper's abstract (OpenAlex)");
      return JSON.stringify({ verdict: "unsupported", issue: "off-topic", reason: "The abstract is about sleep in children.", quotes: [], suggestion: "Cite a source on adolescent sleep spindle growth.", searchAgain: null });
    }
    if (system.startsWith("You are an academic copy editor correcting cited claims")) {
      const segments = JSON.parse(user.match(/<editable_segments>\n([\s\S]*?)\n<\/editable_segments>/)![1]) as Array<{ id: string; text: string }>;
      return JSON.stringify({ edits: [{ id: segments[0].id, text: "Cathodal tDCS boosted placebo analgesia in healthy volunteers " }] });
    }
    throw new Error(`Unexpected prompt: ${system.slice(0, 60)}`);
  };
}

test("checks each citation against its PDF passages or abstract and builds a revision", async () => {
  const { root, index } = await setup();
  const { protection, selectedText } = selection();
  const calls: AgentCompletionRequest[] = [];
  const progress: string[] = [];
  const deps: CitationCheckDeps = {
    loadBibtex: async () => BIB,
    index: () => index,
    complete: fakeModel(calls),
    fetchAbstract: async entry => entry.citekey === "other2019"
      ? { abstract: "We measured sleep spindles in school-age children.", title: "Sleep spindles", retracted: false }
      : { abstract: null, title: null, retracted: entry.citekey === "tu2021manipulating" },
    scanWaitMs: 5_000,
  };
  const params = {
    projectPath: root, provider: "ollama", model: "fixture", message: "", history: [], selectedSkillIds: [], selectedFilePaths: [], lang: "ko",
    analysisMode: "check-citations",
    citationCheckContext: { requestId: "req-1", selectedText, protection, beforeSelection: "", afterSelection: "" },
  } as AgentStreamParams;

  const result = await checkCitations(params, line => progress.push(line), undefined, deps);
  const byKey = new Map(result.findings.map(finding => [finding.citekey, finding]));

  expect(byKey.get("tu2021manipulating")).toMatchObject({
    basis: "fulltext", pdfRelpath: "resources/articles/tu2021.pdf", verdict: "overclaim", issue: "population",
    sentence: "Cathodal tDCS cures chronic pain in all patients.", retracted: true,
    suggestion: "Cathodal tDCS boosted placebo analgesia in healthy volunteers.",
    authors: "Tu et al.", year: "2021",
  });
  expect(byKey.get("tu2021manipulating")!.quotes).toEqual([{ text: expect.stringContaining("boost placebo analgesia"), page: 2 }]);
  expect(byKey.get("cohen2020placebo")).toMatchObject({ basis: "fulltext", verdict: "unverifiable", quotes: [] });
  expect(byKey.get("cohen2020placebo")!.reason).toContain("원문에서 확인하지 못해");
  expect(byKey.get("other2019")).toMatchObject({ basis: "abstract", verdict: "unsupported", issue: "off-topic" });
  expect(byKey.get("missing2000")).toMatchObject({ basis: "none", verdict: "unverifiable", reason: "references.bib에 이 인용 키가 없습니다." });

  // The judge never sees another work's evidence, and the title is labelled as identification only.
  const tuJudge = calls.find(call => (call.messages[0].content as string).startsWith("You check whether") && (call.messages[1].content as string).includes("Manipulating"))!;
  expect(tuJudge.messages[1].content).toContain("[★]");
  expect(tuJudge.messages[1].content).not.toContain("Psychoeducation reduced");
  expect(tuJudge.messages[1].content).toContain('note="identification only, never evidence"');

  expect(result.revision).not.toBeNull();
  const revised = restoreProtectedSelection(schema, protection, result.revision!);
  expect(revised.content.textBetween(0, revised.content.size, "", node => `[@${node.attrs.citekey}]`)).toBe(
    "Cathodal tDCS boosted placebo analgesia in healthy volunteers [@tu2021manipulating]. Psychoeducation reduced the placebo response [@cohen2020placebo]. Sleep spindles grow during adolescence [@other2019]. An uncatalogued claim [@missing2000].",
  );
  expect(progress[0]).toContain("원문 PDF 2편, 초록 1편, 자료 없음 1편");
});

test("parses fenced judgments and withholds verdicts without verifiable quotes", () => {
  const judgment = parseJudgment("<think>…</think>```json\n{\"verdict\":\"Contradicted\",\"issue\":\"wrong-detail\",\"reason\":\"r\",\"quotes\":[\"the effect decreased\"],\"suggestion\":\"s\"}\n```");
  expect(judgment.verdict).toBe("contradicted");
  const passages = [{ label: "A", page: null, content: "In this trial the effect decreased over time." }];
  expect(verifyJudgment(judgment, passages)).toMatchObject({ verdict: "contradicted", quotes: [{ text: "the effect decreased", page: null }] });
  expect(verifyJudgment({ ...judgment, quotes: [{ passage: "A", text: "the effect increased sharply" }] }, passages).verdict).toBe("unverifiable");
  expect(() => parseJudgment('{"verdict":"probably"}')).toThrow();
});
