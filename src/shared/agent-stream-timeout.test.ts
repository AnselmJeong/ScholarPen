import { describe, expect, test } from "bun:test";
import {
  AgentStreamTimeoutError,
  agentStreamTimeoutMessage,
  withAgentStreamTimeout,
} from "./agent-stream-timeout";

describe("withAgentStreamTimeout", () => {
  test("returns an operation result before the deadline", async () => {
    await expect(
      withAgentStreamTimeout(Promise.resolve("ok"), "first-response", 20),
    ).resolves.toBe("ok");
  });

  test("reports the timeout phase and invokes cancellation", async () => {
    let cancelled = false;
    const never = new Promise<string>(() => {});

    try {
      await withAgentStreamTimeout(never, "idle", 10, () => {
        cancelled = true;
      });
      throw new Error("Expected the operation to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentStreamTimeoutError);
      expect((error as AgentStreamTimeoutError).phase).toBe("idle");
      expect(cancelled).toBe(true);
    }
  });
});

describe("agentStreamTimeoutMessage", () => {
  test("provides actionable localized messages", () => {
    expect(agentStreamTimeoutMessage("ko", "first-response")).toContain("120초");
    expect(agentStreamTimeoutMessage("ko", "idle")).toContain("60초");
    expect(agentStreamTimeoutMessage("en", "idle")).toContain("network");
  });
});
