import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { findCitationEvidence } from "./find-citation";
import { streamScholarAgent } from "./service";
import { fileSystem, normalizeSettings } from "../fs/manager";
import type { AgentStreamParams } from "../../shared/rpc-types";
import { parseCitationSearchResult, serializeCitationSearchResult, type CitationEvidence } from "../../shared/citation-evidence";

const params: AgentStreamParams = { message: "find", projectPath: null, history: [], provider: "openai", model: "test-model", selectedSkillIds: [], selectedFilePaths: [], lang: "ko", analysisMode: "find-citation", citationContext: { selectedText: "Selected claim." }, searchEnabled: false };
const settings = normalizeSettings({ paperclipApiKey: "test-key", openaiApiKey: "model-key", webSearchEnabled: false });
function evidence(doi: string, overrides: Partial<CitationEvidence> = {}): CitationEvidence {
  return { claimIndex: 0, side: "supports", evidence: "An exact passage.", context: "Surrounding text.", section: "RESULTS", confidence: 0.95, weight: 0.9,
    paper: { id: null, doi, title: "Title " + doi, pmid: null, authors: ["A"], authorsTruncated: true, year: 2025, journal: null, source: "pmc", design: "cohort", retracted: false, expressionOfConcern: false }, ...overrides };
}
function deps() {
  return {
    createClaims: mock(async () => ["A complete scientific claim."]),
    searchEvidence: mock(async () => [evidence("10.1234/one"), evidence("10.1234/two", { side: "refutes" })]),
    searchFallback: mock(async () => [{ doi: "10.1234/fallback", title: "Fallback", citekey: "fallback2025", authors: ["Author"], year: 2025, bibtex: "", sourceDatabase: "Crossref" as const }]),
  };
}

describe("citation search orchestration", () => {
  test("explicit search works with chat search off; no fallback when evidence is sufficient", async () => {
    const dependencies = deps();
    const result = await findCitationEvidence(params, settings, undefined, dependencies);
    expect(dependencies.createClaims).toHaveBeenCalledTimes(1);
    expect(dependencies.searchEvidence).toHaveBeenCalledTimes(1);
    expect(dependencies.searchFallback).not.toHaveBeenCalled();
    expect(result.evidence.map(item => item.side)).toEqual(["supports", "refutes"]);
    expect(parseCitationSearchResult(serializeCitationSearchResult(result))).toEqual(result);
  });

  test("missing key skips Paperclip and explicitly labels legacy candidates", async () => {
    const dependencies = deps();
    const result = await findCitationEvidence(params, { ...settings, paperclipApiKey: "" }, undefined, dependencies);
    expect(dependencies.searchEvidence).not.toHaveBeenCalled();
    expect(result.notices.join(" ")).toContain("API 키가 없어");
    expect(result.evidence).toEqual([]);
    expect(result.fallback).toHaveLength(1);
  });

  test("partial claim failure keeps evidence and supplements only the missing claim", async () => {
    const dependencies = deps();
    dependencies.createClaims.mockResolvedValue(["First claim.", "Second claim."]);
    dependencies.searchEvidence.mockImplementationOnce(async () => [evidence("10.1234/one"), evidence("10.1234/two")]);
    dependencies.searchEvidence.mockImplementationOnce(async () => { throw new Error("Paperclip API 키를 확인해 주세요."); });
    const result = await findCitationEvidence(params, settings, undefined, dependencies);
    expect(result.evidence).toHaveLength(2);
    expect(dependencies.searchFallback).toHaveBeenCalledWith("Second claim.", 5, undefined, expect.any(AbortSignal));
    expect(result.notices.join(" ")).toContain("주장 2");
    expect(result.fallback).toHaveLength(1);
  });

  test("duplicate passages count as one paper, retracted evidence does not suppress fallback", async () => {
    const dependencies = deps();
    const item = evidence("10.1234/retracted"); item.paper.retracted = true;
    dependencies.searchEvidence.mockResolvedValue([item, item]);
    const result = await findCitationEvidence(params, settings, undefined, dependencies);
    expect(result.evidence).toHaveLength(1);
    expect(dependencies.searchFallback).toHaveBeenCalledTimes(1);
  });

  test("invalid claim generation never sends a partial or fabricated query", async () => {
    const dependencies = deps();
    dependencies.createClaims.mockRejectedValue(new Error("검색 주장 형식 오류"));
    await expect(findCitationEvidence(params, settings, undefined, dependencies)).rejects.toThrow("형식 오류");
    expect(dependencies.searchEvidence).not.toHaveBeenCalled();
    expect(dependencies.searchFallback).not.toHaveBeenCalled();
  });

  test("cancellation stops before fallback rather than being treated as search failure", async () => {
    const dependencies = deps();
    const controller = new AbortController();
    dependencies.searchEvidence.mockImplementation(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); });
    await expect(findCitationEvidence(params, settings, controller.signal, dependencies)).rejects.toHaveProperty("name", "AbortError");
    expect(dependencies.searchFallback).not.toHaveBeenCalled();
  });
});

describe("Find Citation stream", () => {
  const originalFetch = globalThis.fetch;
  const getSettings = spyOn(fileSystem, "getSettings");
  afterEach(() => { globalThis.fetch = originalFetch; getSettings.mockRestore(); });

  test("runs a single LLM preparation request and publishes structured evidence without another generation", async () => {
    getSettings.mockResolvedValue(settings);
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).includes("chat/completions")) return Response.json({ choices: [{ message: { content: '{"claims":["A complete scientific claim."]}' } }] });
      if (String(url).includes("claims/support")) return Response.json({ supports: ["one", "two"].map(id => ({
        evidence: "An exact passage.", confidence: 0.95, weight: 0.8, context: "Context.", section: "RESULTS",
        paper: { id, title: `Study ${id}`, doi: `10.1234/${id}`, authors: ["A"], authors_truncated: true, retracted: false, expression_of_concern: false },
      })), refutes: [] });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const chunks: string[] = [];
    const onDone = mock(() => {}), onError = mock((_message: string) => {});
    await streamScholarAgent(params, { onChunk: text => chunks.push(text), onDone, onError });
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(urls).toHaveLength(2);
    expect(parseCitationSearchResult(chunks.join(""))?.evidence).toHaveLength(2);
    expect(chunks.join("")).not.toContain("test-key");
  });
});
