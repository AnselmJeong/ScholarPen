import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeClient, claudeClient, claudeInput } from "./client";
import { claudeEnvironment } from "./process";
import { completeAgentModel, listProviderModels, streamAgentModel } from "../agent/providers";
import { normalizeSettings } from "../fs/manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(scenario: string, timeoutMs = 1500) {
  const home = await mkdtemp(join(tmpdir(), "scholarpen-claude-test-"));
  const log = join(home, "requests.jsonl");
  const client = new ClaudeClient({ home, command: [process.execPath, join(import.meta.dir, "fixtures/cli.ts"), scenario, log], timeoutMs });
  cleanups.push(async () => { client.close(); await Bun.sleep(50); await rm(home, { recursive: true, force: true }); });
  return { client, home, requests: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}
const request = { model: "sonnet", messages: [{ role: "system" as const, content: "Preserve citations." }, { role: "assistant" as const, content: "Earlier answer" }, { role: "user" as const, content: "Current manuscript" }] };
async function collect(stream: AsyncIterable<string>) { let text = ""; for await (const chunk of stream) text += chunk; return text; }

test("streams UTF-8 once, preserves context and disables tools, hooks, persistence and fallback", async () => {
  const { client, requests, home } = await fixture("success");
  expect(await collect(client.stream({ ...request, thinkingLevel: "high" }))).toBe("안녕하세요");
  const calls = await requests();
  const args = calls.find(call => call.args?.includes("--print")).args;
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args).toContain("--safe-mode");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--no-session-persistence");
  expect(args).not.toContain("--fallback-model");
  expect(args).not.toContain("--bare"); // Bare mode bypasses subscription OAuth.
  expect(args[args.indexOf("--effort") + 1]).toBe("high");
  const input = calls.find(call => call.input);
  expect(input.system).toContain("Preserve citations.");
  expect(input.input.message.content).toEqual([{ type: "text", text: "[assistant]\nEarlier answer" }, { type: "text", text: "[user]\nCurrent manuscript" }]);
  expect(await readdir(join(home, "workspace"))).toEqual([]);
});

test("supports result-only output", async () => {
  const { client } = await fixture("result-only");
  expect(await collect(client.stream(request))).toBe("안녕하세요");
});

for (const scenario of ["api-key", "third-party", "signed-out"]) test(`blocks ${scenario} before generation`, async () => {
  const { client, requests } = await fixture(scenario);
  await expect(collect(client.stream(request))).rejects.toThrow();
  expect((await requests()).some(call => call.args?.includes("--print"))).toBeFalse();
});

for (const scenario of ["quota", "overage", "retry-limit", "limit-result", "assistant-error"]) test(`stops ${scenario} without retries or model switches`, async () => {
  const { client, requests } = await fixture(scenario);
  await expect(collect(client.stream(request))).rejects.toThrow("유료 API로 전환하지 않았습니다");
  expect((await requests()).filter(call => call.args?.includes("--print"))).toHaveLength(1);
  if (scenario === "quota") {
    await expect(collect(client.stream(request))).rejects.toThrow("한도");
    expect((await requests()).filter(call => call.args?.includes("--print"))).toHaveLength(1);
  }
});

for (const scenario of ["malformed", "crash", "truncated", "model-error"]) test(`surfaces ${scenario} and cleans request files`, async () => {
  const { client, home } = await fixture(scenario);
  await expect(collect(client.stream(request))).rejects.toThrow();
  expect(await readdir(join(home, "workspace"))).toEqual([]);
});

test("cancels a silent process and times out a stalled run", async () => {
  const { client, requests, home } = await fixture("hang", 700);
  const controller = new AbortController();
  const run = collect(client.stream({ ...request, signal: controller.signal }));
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(10);
    if ((await requests().catch(() => [])).some(call => call.input)) break;
  }
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(join(home, "workspace"))).toEqual([]);
  await expect(collect(client.stream(request))).rejects.toThrow("시간이 초과");
});

test("official login, cancellation and logout use isolated config and never Console billing", async () => {
  const { client, requests } = await fixture("login");
  expect((await client.status()).state).toBe("signedOut");
  await client.login();
  expect((await client.status()).state).toBe("signingIn");
  await client.cancelLogin();
  expect((await client.status()).state).toBe("signedOut");
  await client.login(); await Bun.sleep(300);
  expect((await client.status()).state).toBe("connected");
  await client.logout();
  expect((await client.status()).state).toBe("signedOut");
  const calls = await requests();
  expect(calls.find(call => call.args?.includes("login")).args).toContain("--claudeai");
  expect(calls.some(call => call.args?.includes("--console"))).toBeFalse();
});

test("validates images and preserves them as native input blocks", () => {
  const input = claudeInput([{ role: "user", content: "Figure", images: [{ name: "figure.png", dataUrl: "data:image/png;base64,aGVsbG8=" }] }]);
  expect(input.message.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
  expect(() => claudeInput([{ role: "user", content: "", images: [{ name: "x", dataUrl: "file:///private" }] }])).toThrow();
});

test("environment excludes API credentials, OAuth tokens, model overrides and provider endpoints", () => {
  const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CONFIG_DIR"];
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = "untrusted";
    const env = claudeEnvironment("/private/scholarpen-claude");
    for (const name of names.slice(0, -1)) expect(env[name]).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/private/scholarpen-claude");
  } finally { names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); }
});

test("all provider entry points use subscription and never HTTP fallback even when paid keys exist", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const stream = spyOn(claudeClient, "stream").mockImplementation(async function* () { throw new Error("subscription exhausted"); });
  const models = spyOn(claudeClient, "models").mockRejectedValue(new Error("login required"));
  const settings = normalizeSettings({ anthropicApiKey: "removed-key", openaiApiKey: "paid-key", ollamaApiKey: "paid-key" });
  try {
    await expect(completeAgentModel({ ...request, provider: "anthropic" }, settings)).rejects.toThrow("subscription exhausted");
    await expect(collect(streamAgentModel({ ...request, provider: "anthropic" }, settings))).rejects.toThrow("subscription exhausted");
    await expect(listProviderModels("anthropic", settings)).rejects.toThrow("login required");
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); stream.mockRestore(); models.mockRestore(); }
});

test("removes legacy Claude keys while preserving other providers and model choices", () => {
  const settings = normalizeSettings({ sidebarAgentProvider: "anthropic", sidebarAgentModel: "opus", anthropicApiKey: "old-secret", openaiApiKey: "preserved", tinyfishApiKey: "search-key" });
  expect(JSON.stringify(settings)).not.toContain("old-secret");
  expect("anthropicApiKey" in settings).toBeFalse();
  expect(settings.sidebarAgentProvider).toBe("anthropic");
  expect(settings.sidebarAgentModel).toBe("opus");
  expect(settings.openaiApiKey).toBe("preserved");
  expect(settings.tinyfishApiKey).toBe("search-key");
  expect(settings.modelProviders.anthropic.enabled).toBeTrue();
});
