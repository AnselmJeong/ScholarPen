import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient, codexClient, codexInput } from "./client";
import { CODEX_CONFIG, CodexTransport, codexEnvironment } from "./transport";
import { completeAgentModel, listProviderModels, streamAgentModel } from "../agent/providers";
import { normalizeSettings } from "../fs/manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(scenario: string) {
  const home = await mkdtemp(join(tmpdir(), "scholarpen-codex-test-"));
  const log = join(home, "requests.jsonl");
  const client = new CodexClient(() => new CodexTransport({ home, command: [process.execPath, join(import.meta.dir, "fixtures/app-server.ts"), scenario, log], timeoutMs: 300 }));
  cleanups.push(async () => { client.close(); await new Promise(resolve => setTimeout(resolve, 30)); await rm(home, { recursive: true, force: true }); });
  return { client, requests: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}
const request = { model: "test-model", messages: [{ role: "user" as const, content: "Reply in Korean" }] };
async function collect(source: AsyncIterable<string>) { let text = ""; for await (const chunk of source) text += chunk; return text; }

test("streams UTF-8, filters other threads, avoids duplicate final text and denies tool requests", async () => {
  const { client, requests } = await fixture("success");
  expect(await collect(client.stream({ ...request, thinkingLevel: "high" }))).toBe("안녕하세요");
  const calls = await requests();
  expect(calls.find(r => r.method === "thread/start").params).toMatchObject({ modelProvider: "openai", sandbox: "read-only", approvalPolicy: "never", ephemeral: true });
  expect(calls.find(r => r.method === "turn/start").params.effort).toBe("low");
  expect(calls.find(r => r.id === "approval-1").error.code).toBe(-32601);
});

for (const scenario of ["api-key", "exhausted", "blocked", "unknown-quota", "quota-error"]) {
  test(`refuses ${scenario} before starting a model turn, even with credits available`, async () => {
    const { client, requests } = await fixture(scenario);
    await expect(collect(client.stream(request))).rejects.toThrow();
    expect((await requests()).some(r => r.method === "turn/start" || r.method === "thread/start")).toBeFalse();
  });
}

test("subscription quota errors are surfaced without switching models or providers", async () => {
  const { client, requests } = await fixture("limit-turn");
  await expect(collect(client.stream(request))).rejects.toThrow("유료 API로 전환하지 않았습니다");
  expect((await requests()).filter(r => r.method === "turn/start")).toHaveLength(1);
});

for (const scenario of ["crash", "malformed", "hang-start"]) {
  test(`fails promptly on ${scenario} and allows a new connection`, async () => {
    const { client } = await fixture(scenario);
    await expect(collect(client.stream(request))).rejects.toThrow();
    expect((await client.status()).state).toBe("connected");
  });
}

test("cancels a quiet turn and sends interrupt", async () => {
  const { client, requests } = await fixture("hang");
  const controller = new AbortController();
  const run = collect(client.stream({ ...request, signal: controller.signal }));
  await new Promise(resolve => setTimeout(resolve, 120));
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await requests()).some(r => r.method === "turn/interrupt")).toBeTrue();
});

test("ChatGPT login and logout stay within the official account methods", async () => {
  const { client, requests } = await fixture("login");
  expect((await client.status()).state).toBe("signedOut");
  expect(await client.login()).toStartWith("https://auth.openai.com/");
  expect((await client.status()).state).toBe("signingIn");
  await new Promise(resolve => setTimeout(resolve, 90));
  expect((await client.status()).state).toBe("connected");
  expect((await client.models())[0].id).toBe("test-model");
  await client.logout();
  expect((await requests()).find(r => r.method === "account/login/start").params).toEqual({ type: "chatgpt" });
  expect((await requests()).some(r => r.method === "account/logout")).toBeTrue();
});

test("supports login cancellation", async () => {
  const { client, requests } = await fixture("login");
  await client.login();
  await client.cancelLogin();
  expect((await requests()).find(r => r.method === "account/login/cancel").params).toEqual({ loginId: "login-1" });
});

test("refresh restarts the app server and reloads the catalog without losing subscription auth", async () => {
  const { client, requests } = await fixture("refresh-models");
  expect((await client.models()).map(m => m.id)).toEqual(["gpt-5.6-sol"]);
  expect(await client.refresh()).toMatchObject({ state: "connected", cliVersion: "0.160.0", cliPath: process.execPath });
  expect((await client.models()).map(m => m.id)).toEqual(["gpt-6.1-sol"]);
  expect((await requests()).filter(r => r.method === "initialize")).toHaveLength(2);
  expect((await requests()).some(r => r.method === "account/logout" || r.method === "account/login/start")).toBeFalse();
});

test("refresh preserves a pending browser login", async () => {
  const { client, requests } = await fixture("login");
  await client.login();
  expect((await client.refresh()).state).toBe("signingIn");
  expect((await requests()).filter(r => r.method === "initialize")).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 90));
  expect((await client.status()).state).toBe("connected");
});

test("refresh cannot interrupt an active turn and works again after cancellation", async () => {
  const { client, requests } = await fixture("hang");
  const controller = new AbortController();
  const run = collect(client.stream({ ...request, signal: controller.signal }));
  await new Promise(resolve => setTimeout(resolve, 120));
  await expect(client.refresh()).rejects.toThrow("응답을 생성 중");
  expect((await requests()).filter(r => r.method === "initialize")).toHaveLength(1);
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect((await client.refresh()).state).toBe("connected");
});

test("preserves document context, history, and validated image input", () => {
  const result = codexInput([{ role: "system", content: "instructions" }, { role: "assistant", content: "history" }, { role: "user", content: "document", images: [{ name: "plot.png", dataUrl: "data:image/png;base64,aGVsbG8=" }] }]);
  expect(result[0]).toMatchObject({ type: "text", text: "[assistant]\nhistory" });
  expect(result[1]).toMatchObject({ type: "text", text: "[user]\ndocument" });
  expect(result[2]).toMatchObject({ type: "image", url: "data:image/png;base64,aGVsbG8=" });
});

test("never inherits API credentials or another Codex home", () => {
  const savedOpenai = process.env.OPENAI_API_KEY;
  const savedCodex = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = "test-api-key";
  process.env.CODEX_API_KEY = "test-codex-key";
  try {
    const env = codexEnvironment("/private/test-home");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBe("/private/test-home");
    expect(CODEX_CONFIG).toContain('forced_login_method="chatgpt"');
  } finally {
    if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenai;
    if (savedCodex === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = savedCodex;
  }
});

test("all provider entry points route Codex exclusively and propagate failure without HTTP fallback", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const stream = spyOn(codexClient, "stream").mockImplementation(async function* () { throw new Error("subscription exhausted"); });
  const models = spyOn(codexClient, "models").mockRejectedValue(new Error("login required"));
  const settings = normalizeSettings({ openaiApiKey: "paid-key", ollamaApiKey: "paid-key" });
  try {
    await expect(completeAgentModel({ ...request, provider: "codex" }, settings)).rejects.toThrow("subscription exhausted");
    await expect(collect(streamAgentModel({ ...request, provider: "codex" }, settings))).rejects.toThrow("subscription exhausted");
    await expect(listProviderModels("codex", settings)).rejects.toThrow("login required");
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); stream.mockRestore(); models.mockRestore(); }
});
