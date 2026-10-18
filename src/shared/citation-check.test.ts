import { describe, expect, test } from "bun:test";
import {
  extractCitationInstances, parseCitationCheckResult, serializeCitationCheckResult, verdictLabel,
  type CitationCheckResult,
} from "./citation-check";

describe("extractCitationInstances", () => {
  test("pairs a citation inside the sentence with that sentence", () => {
    const [instance] = extractCitationInstances("Placebo responses are rising in CNS trials [@cohen2020]. Other text.");
    expect(instance).toMatchObject({
      citekey: "cohen2020",
      sentence: "Placebo responses are rising in CNS trials.",
      markedSentence: "Placebo responses are rising in CNS trials [★].",
      coCited: [],
    });
  });

  test("gives a citation placed after the full stop to the sentence it closes", () => {
    const instances = extractCitationInstances("tDCS가 크림의 위약 효과를 조절한다. [@krum2010] 또한 NIBS가 위약 회로와 중첩된다 [@burke2022][@fon2019].");
    expect(instances.map(item => [item.citekey, item.sentence])).toEqual([
      ["krum2010", "tDCS가 크림의 위약 효과를 조절한다."],
      ["burke2022", "또한 NIBS가 위약 회로와 중첩된다."],
      ["fon2019", "또한 NIBS가 위약 회로와 중첩된다."],
    ]);
    expect(instances[1].markedSentence).toBe("또한 NIBS가 위약 회로와 중첩된다 [★ + 1 other citation].");
    expect(instances[1].coCited).toEqual(["fon2019"]);
    expect(instances[1].context).toBe("tDCS가 크림의 위약 효과를 조절한다.");
  });

  test("reads grouped keys and locators and does not split at abbreviations", () => {
    const instances = extractCitationInstances("Responses vary (e.g. responders vs. non-responders) across subjects [@wie2014, p. 3; @lopez2014].");
    expect(instances.map(item => item.citekey)).toEqual(["wie2014", "lopez2014"]);
    expect(instances[0].sentence).toBe("Responses vary (e.g. responders vs. non-responders) across subjects.");
    expect(instances[0].markedSentence).toContain("[★ + 1 other citation]");
  });

  test("checks the same work separately in each sentence that cites it", () => {
    const instances = extractCitationInstances("First claim [@a2020]. Second claim [@a2020].");
    expect(instances.map(item => item.sentence)).toEqual(["First claim.", "Second claim."]);
  });

  test("returns nothing for a passage without citations", () => {
    expect(extractCitationInstances("No citations here.")).toEqual([]);
  });
});

describe("result persistence", () => {
  const result: CitationCheckResult = {
    version: 1, requestId: "r1", selectedText: "Claim [@a].", notices: [], revision: null,
    findings: [{
      citekey: "a", sentence: "Claim.", coCited: [], title: "T", authors: "Kim", year: "2020", doi: null,
      basis: "abstract", pdfRelpath: null, verdict: "unsupported", issue: "off-topic", reason: "r",
      quotes: [], suggestion: "Cite another source.", retracted: false,
    }],
  };

  test("round-trips through the assistant message", () => {
    expect(parseCitationCheckResult(`진행 중…${serializeCitationCheckResult(result)}`)).toEqual(result);
  });

  test("rejects a malformed finding", () => {
    const broken = serializeCitationCheckResult({ ...result, findings: [{ ...result.findings[0], verdict: "maybe" as never }] });
    expect(parseCitationCheckResult(broken)).toBeNull();
  });

  test("labels abstract-only absence as weaker than a miscitation", () => {
    expect(verdictLabel({ verdict: "unsupported", basis: "abstract" })).toBe("초록에서 확인 안 됨");
    expect(verdictLabel({ verdict: "unsupported", basis: "fulltext" })).toBe("원문에 근거 없음");
  });
});
