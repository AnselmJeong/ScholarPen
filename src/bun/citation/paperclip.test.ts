import { describe, expect, test } from "bun:test";
import { searchPaperclipEvidence } from "./paperclip";

export const paperclipPassage = {
  evidence: "Negative information was recalled more frequently.", confidence: 0.94, weight: 0.82,
  context: "In adults with depression. Negative information was recalled more frequently.", section: "RESULTS",
  paper: {
    id: "PMC123", title: "Memory study", doi: "10.1234/memory", pmid: "123", authors: ["Test Author"],
    authors_truncated: true, year: 2025, journal: "Test Journal", source: "pmc", design: "cohort",
    retracted: false, expression_of_concern: false,
  },
};

describe("Paperclip Evidence API", () => {
  test("sends only the claim, authenticates in a header, and retains both sides with exact passages", async () => {
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("https://paperclip.gxl.ai/api/v1/claims/support");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-key");
      expect(headers.has("X-Evidence-Permalink")).toBeFalse();
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ claim: "Depression is associated with negative memory bias.", mode: "claim", min_conf: 0.8, top_n: 100, limit: 20, hybrid: true, include_context: true });
      return Response.json({ supports: [paperclipPassage], refutes: [{ ...paperclipPassage, evidence: "No group difference was found." }] });
    }) as unknown as typeof fetch;
    const results = await searchPaperclipEvidence("Depression is associated with negative memory bias.", " test-key ", 2, { fetchFn });
    expect(results.map(r => r.side)).toEqual(["supports", "refutes"]);
    expect(results[0]).toMatchObject({ claimIndex: 2, evidence: paperclipPassage.evidence, context: paperclipPassage.context, paper: { authorsTruncated: true } });
  });

  test("discards malformed and low-confidence entries; preserves missing DOI and retraction flags", async () => {
    const fetchFn = (async () => Response.json({ supports: [
      null, { ...paperclipPassage, confidence: 0.2 }, { ...paperclipPassage, paper: {} },
      { ...paperclipPassage, paper: { ...paperclipPassage.paper, doi: null, retracted: true, expression_of_concern: true } },
    ], refutes: [] })) as unknown as typeof fetch;
    const results = await searchPaperclipEvidence("A scientific claim.", "key", 0, { fetchFn });
    expect(results).toHaveLength(1);
    expect(results[0].paper).toMatchObject({ doi: null, retracted: true, expressionOfConcern: true });
  });

  for (const [status, message] of [[401, "API 키"], [403, "API 키"], [429, "이용 한도"], [503, "HTTP 503"]] as const) {
    test(`HTTP ${status} produces an actionable error without exposing the response body`, async () => {
      const fetchFn = (async () => new Response("secret-key-and-manuscript", { status })) as unknown as typeof fetch;
      await expect(searchPaperclipEvidence("A scientific claim.", "key", 0, { fetchFn })).rejects.toThrow(message);
      try { await searchPaperclipEvidence("A scientific claim.", "key", 0, { fetchFn }); }
      catch (error) { expect(String(error)).not.toContain("secret-key-and-manuscript"); }
    });
  }

  test("rejects missing result arrays instead of claiming no evidence", async () => {
    await expect(searchPaperclipEvidence("A scientific claim.", "key", 0, { fetchFn: (async () => Response.json({ error: "bad" })) as unknown as typeof fetch })).rejects.toThrow("응답 형식");
  });

  test("bounds requests and preserves caller cancellation", async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    await expect(searchPaperclipEvidence("A scientific claim.", "key", 0, { fetchFn, timeoutMs: 5 })).rejects.toThrow("응답 시간");
    const controller = new AbortController(); controller.abort();
    await expect(searchPaperclipEvidence("A scientific claim.", "key", 0, { fetchFn, signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
  });
});
