import { expect, test } from "bun:test";
import { completeLocalStyleModel } from "./local-style-model";
test("a loopback cloud alias never receives private sample text", async () => {
  const bodies: string[] = [];
  const fetcher = (async (_url, init) => { bodies.push(String(init?.body)); return Response.json({ remote_host: "https://ollama.com", remote_model: "cloud", model_info: {} }); }) as typeof fetch;
  await expect(completeLocalStyleModel("http://localhost:11434/v1", "alias", [{ role: "user", content: "PRIVATE SAMPLE" }], new AbortController().signal, fetcher)).rejects.toThrow("전송하지");
  expect(bodies).toEqual(['{"model":"alias"}']);
});
test("verified local model receives one bounded non-streaming analysis request", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetcher = (async (url, init) => { requests.push({ url: String(url), body: String(init?.body) }); return Response.json(requests.length === 1 ? { model_info: { "general.architecture": "qwen" } } : { message: { content: "result" } }); }) as typeof fetch;
  expect(await completeLocalStyleModel("http://127.0.0.1:11434/api", "qwen:8b", [{ role: "user", content: "sample" }], new AbortController().signal, fetcher)).toBe("result");
  expect(requests[1]?.url).toBe("http://127.0.0.1:11434/api/chat"); expect(JSON.parse(requests[1]!.body).stream).toBeFalse();
});
