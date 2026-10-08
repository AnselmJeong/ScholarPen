import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileSystem, normalizeSettings } from "../fs/manager";
import { buildAgentMessages } from "./context-builder";
import type { AgentStreamParams } from "../../shared/rpc-types";

const recall = spyOn(fileSystem, "recallProjectMemory");
const files = spyOn(fileSystem, "listProjectFiles").mockResolvedValue([]);
afterAll(() => { recall.mockRestore(); files.mockRestore(); });
const paths: string[] = [];
afterEach(async () => { recall.mockReset(); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const settings = normalizeSettings({ webSearchEnabled: false });
async function params(): Promise<AgentStreamParams> {
  const path = await mkdtemp(join(tmpdir(), "scholarpen-context-")); paths.push(path);
  return { message: "How should we use this terminology?", projectPath: path, history: [], provider: "ollama", model: "test", selectedSkillIds: [], selectedFilePaths: [], lang: "ko", projectSourcesEnabled: false };
}

test("agent context and visible references include only recalled project notes", async () => {
  recall.mockResolvedValue([{ id: "m1", text: "Keep phase distinct from state.", context: "Confirmed terminology" }]);
  const request = await params();
  const result = await buildAgentMessages(request, settings);
  expect(recall).toHaveBeenCalledWith(request.projectPath, request.message, undefined);
  expect(result.messages[0].content).toContain('<project_memory reference_only="true">');
  expect(result.references).toContain("[M1] Keep phase distinct from state.");
});

test("memory outage remains visible but does not block generation", async () => {
  recall.mockRejectedValue(new Error("offline"));
  const result = await buildAgentMessages(await params(), settings);
  expect(result.messages.at(-1)?.role).toBe("user");
  expect(result.messages[0].content).toContain("Project memory retrieval was unavailable");
  expect(result.references).toContain("Hindsight 연결 실패");
});

test("cancellation during memory lookup stops generation", async () => {
  const controller = new AbortController();
  recall.mockImplementation(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); });
  await expect(buildAgentMessages(await params(), settings, controller.signal)).rejects.toThrow("Aborted");
});
