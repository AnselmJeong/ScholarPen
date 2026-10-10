import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const [scenario, log, ...args] = process.argv.slice(2);
const marker = join(process.env.CLAUDE_CONFIG_DIR!, "signed-in");
appendFileSync(log, `${JSON.stringify({ args, apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN, endpoint: process.env.ANTHROPIC_BASE_URL, configDir: process.env.CLAUDE_CONFIG_DIR })}\n`);
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.includes("--version")) {
  console.log("2.1.273 (Claude Code)");
} else if (args.includes("status")) {
  const loggedIn = scenario !== "login" && scenario !== "signed-out" || existsSync(marker);
  send({ loggedIn, authMethod: scenario === "api-key" ? "api_key" : "claude.ai", apiProvider: scenario === "third-party" ? "bedrock" : "firstParty", subscriptionType: "pro", email: "test@example.com" });
  if (!loggedIn) process.exitCode = 1;
} else if (args.includes("login")) {
  await Bun.sleep(150);
  writeFileSync(marker, "ok");
} else if (args.includes("logout")) {
  if (existsSync(marker)) unlinkSync(marker);
} else if (args.includes("--print")) {
  const input = await Bun.stdin.text();
  const system = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
  appendFileSync(log, `${JSON.stringify({ input: JSON.parse(input), system })}\n`);
  if (scenario === "hang") { await Bun.sleep(60_000); }
  else if (scenario === "malformed") console.log("not-json");
  else if (scenario === "crash") process.exitCode = 1;
  else if (scenario === "quota" || scenario === "overage") {
    send({ type: "rate_limit_event", rate_limit_info: { status: scenario === "quota" ? "rejected" : "allowed", isUsingOverage: scenario === "overage", resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    await Bun.sleep(60_000);
  } else if (scenario === "retry-limit") {
    send({ type: "system", subtype: "api_retry", error_status: 429 });
    await Bun.sleep(60_000);
  } else if (scenario === "limit-result" || scenario === "model-error") {
    send({ type: "result", subtype: "error_during_execution", is_error: true, errors: [scenario === "limit-result" ? "Rate limit exceeded" : "Model unavailable"] });
    process.exitCode = 1;
  } else if (scenario === "assistant-error") {
    send({ type: "assistant", error: "rate_limit" });
    process.exitCode = 1;
  } else {
    if (scenario !== "result-only") {
      send({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "private" } } });
      const bytes = Buffer.from(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "안녕하세요" } } }) + "\n");
      const split = bytes.indexOf(Buffer.from("안")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      await Bun.sleep(5);
      process.stdout.write(bytes.subarray(split));
      send({ type: "assistant", message: { content: [{ type: "text", text: "안녕하세요" }] } });
    }
    if (scenario !== "truncated") send({ type: "result", subtype: "success", is_error: false, result: "안녕하세요" });
  }
}
