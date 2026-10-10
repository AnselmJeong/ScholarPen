import { afterEach, describe, expect, test } from "bun:test";
import { parseCitationClaims, createCitationClaims } from "./citation-claims";
import { normalizeSettings } from "../fs/manager";
import type { AgentStreamParams } from "../../shared/rpc-types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const params: AgentStreamParams = { message: "find", projectPath: null, history: [], provider: "openai", model: "test-model", selectedSkillIds: [], selectedFilePaths: [], lang: "ko", analysisMode: "find-citation", citationContext: { selectedText: "우울증에서는 부정적인 기억이 더 잘 떠오를 수 있다.", beforeSelection: "This population is adults.", afterSelection: "This is an association." } };

describe("claim generation", () => {
  test("retains qualified negative claims and splits independent claims without truncation", () => {
    const claims = ["Treatment may not improve memory in older adults.", "Treatment is associated with sleep quality."];
    expect(parseCitationClaims('```json\n' + JSON.stringify({ claims }) + '\n```')).toEqual(claims);
    for (const value of [[], ["a".repeat(591)], ["한글 주장"], ["One", "Two", "Three", "Four"]]) {
      expect(() => parseCitationClaims(JSON.stringify({ claims: value }))).toThrow();
    }
    expect(() => parseCitationClaims("invented DOI: 10.0000/test")).toThrow();
  });

  test("uses one model request with bounded context and preservation instructions", async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContain("Never turn association into causation");
      expect(JSON.parse(body.messages[1].content)).toEqual({ selectedText: params.citationContext!.selectedText, beforeSelection: "This population is adults.", afterSelection: "This is an association." });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ claims: ["Adults with depression may preferentially recall negative information."] }) } }] });
    }) as typeof fetch;
    expect(await createCitationClaims(params, normalizeSettings({ openaiApiKey: "test" }))).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("a user-edited retry needs no LLM and invalid claims never get silently shortened", async () => {
    globalThis.fetch = (() => { throw new Error("Must not call model"); }) as unknown as typeof fetch;
    expect(await createCitationClaims({ ...params, citationContext: { selectedText: "original", claims: ["A user-edited scientific claim."] } }, normalizeSettings({}))).toEqual(["A user-edited scientific claim."]);
    await expect(createCitationClaims({ ...params, citationContext: { selectedText: "x".repeat(12_001) } }, normalizeSettings({}))).rejects.toThrow("선택문이 너무 깁니다");
  });
});
