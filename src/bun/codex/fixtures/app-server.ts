// A deterministic stdio peer: exercises the production transport without network or credentials.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.argv[2];
const logFile = process.argv[3];
let signedIn = scenario !== "login";
function send(message: unknown) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function notification(method: string, params: unknown) { send({ method, params }); }
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(logFile, `${line}\n`);
  if (!request.method || request.id === undefined) continue;
  const reply = (result: unknown) => send({ id: request.id, result });
  switch (request.method) {
    case "initialize": reply({ userAgent: "scholarpen/0.160.0 (fixture)" }); break;
    case "account/read":
      reply({ account: !signedIn ? null : scenario === "api-key" ? { type: "apiKey" } : { type: "chatgpt", email: "test@example.com", planType: "plus" } }); break;
    case "account/rateLimits/read":
      if (scenario === "quota-error") send({ id: request.id, error: { code: -1, message: "offline" } });
      else reply({ ordinaryUsageAllowed: scenario === "blocked" ? false : null, rateLimits: scenario === "unknown-quota" ? {} : { limitId: "codex", primary: { usedPercent: scenario === "exhausted" ? 100 : 20, windowDurationMins: 300, resetsAt: 2_000_000_000 }, credits: { hasCredits: true, unlimited: true } } });
      break;
    case "account/login/start":
      reply({ type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/authorize?test=1" });
      setTimeout(() => { signedIn = true; notification("account/login/completed", { loginId: "login-1", success: true }); }, 60);
      break;
    case "account/login/cancel": signedIn = false; reply({ status: "canceled" }); break;
    case "account/logout": signedIn = false; reply({}); break;
    case "model/list": {
      const starts = readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(r => r.method === "initialize").length;
      const model = scenario === "refresh-models" ? starts > 1 ? "gpt-6.1-sol" : "gpt-5.6-sol" : "test-model";
      reply({ data: [{ id: "model-alias", model, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }], nextCursor: null }); break;
    }
    case "thread/start": reply({ thread: { id: "thread-1" } }); break;
    case "turn/start": {
      if (scenario === "crash") process.exit(7);
      if (scenario === "malformed") { process.stdout.write("not json\n"); break; }
      if (scenario === "hang-start") break;
      reply({ turn: { id: "turn-1" } });
      if (scenario === "hang") break;
      const params = { threadId: "thread-1", turnId: "turn-1", itemId: "message-1" };
      if (scenario === "limit-turn") {
        notification("turn/completed", { ...params, turn: { status: "failed", error: { message: "Usage limit exceeded", codexErrorInfo: "usageLimitExceeded" } } }); break;
      }
      // Unrelated threads must not contaminate the Sidebar response.
      notification("item/agentMessage/delta", { ...params, threadId: "other", delta: "WRONG" });
      notification("item/reasoning/summaryTextDelta", { ...params, delta: "thinking" });
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params });
      const bytes = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: { ...params, delta: "안녕하세요" } })}\n`);
      const split = bytes.indexOf(Buffer.from("안")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(split));
        notification("item/completed", { ...params, item: { id: "message-1", type: "agentMessage", text: "안녕하세요" } });
        notification("turn/completed", { ...params, turn: { status: "completed", error: null } });
      }, 10);
      break;
    }
    case "turn/interrupt": reply({}); break;
    case "thread/unsubscribe": reply({}); break;
    default: reply({});
  }
}
