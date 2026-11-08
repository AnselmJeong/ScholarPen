import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentThreadStore } from "./thread-store";

test("a new score command deletes old detection turns from saved chat but preserves unrelated messages", async () => {
  const path = await mkdtemp(join(tmpdir(), "scholarpen-score-history-"));
  try {
    const store = await new AgentThreadStore(path).ready();
    const threadId = store.createThread({ provider: "ollama", model: "test" }).id;
    const save = (role: "user" | "assistant", content: string) => store.saveMessage({ threadId, role, content });
    save("user", "Keep this ordinary conversation"); save("assistant", "An ordinary reply");
    save("user", "/ai-score"); save("assistant", "DetectorScope로 구간별 점수와 원문 근거를 분석하고 있습니다…\n\n**DetectorScope · OLD**");
    save("user", "Keep this later question"); save("assistant", "A later reply");
    save("user", "/ai-score");
    expect(store.getThread(threadId).messages.map(m => m.content)).toEqual([
      "Keep this ordinary conversation", "An ordinary reply", "Keep this later question", "A later reply", "/ai-score",
    ]);
    save("assistant", "**DetectorScope · NEW**");
    const reopened = await new AgentThreadStore(path).ready();
    expect(reopened.getThread(threadId).messages.filter(m => m.content.includes("DetectorScope"))).toHaveLength(1);
    expect(reopened.getThread(threadId).messages.at(-1)!.content).toBe("**DetectorScope · NEW**");
  } finally { await rm(path, { recursive: true, force: true }); }
});
