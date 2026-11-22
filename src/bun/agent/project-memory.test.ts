import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileSystem, normalizeSettings } from "../fs/manager";
import { buildAgentMessages } from "./context-builder";
import { snapshotActiveDocument } from "../../shared/active-document-context";
import { setDocumentEditGuide } from "./document-edit-guide";
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

test("general chat in a project may edit manuscripts, with paragraph ids and the document's rules; selection reviews may not", async () => {
  recall.mockResolvedValue([]);
  const request = await params();
  const documentPath = join(request.projectPath!, "documents", "intro.scholarpen.json");
  const activeDocument = snapshotActiveDocument(documentPath,
    [{ id: "3f2a9c1e-0000", type: "paragraph", content: [{ type: "text", text: "LIVE TEXT" }] }], { paragraphIds: true });
  const asked: string[] = [];
  setDocumentEditGuide(async (projectPath, path) => { asked.push(`${projectPath}|${path}`); return "Edit level of the active document: Proofread."; });
  try {
    const chat = await buildAgentMessages({ ...request, activeDocument }, settings);
    const all = chat.messages.map(message => message.content).join("\n");
    expect(chat.messages[0].content).toContain("<scholarpen_edit document=");
    expect(chat.messages[0].content).not.toContain("You are read-only");
    expect(chat.messages[0].content).toContain("<active_document_edit_rules>\nEdit level of the active document: Proofread.\n</active_document_edit_rules>");
    expect(asked).toEqual([`${request.projectPath}|${documentPath}`]);
    expect(all).toContain("[¶3f2a9c1e] LIVE TEXT");

    const deepen = await buildAgentMessages({ ...request, activeDocument, analysisMode: "deepen", deepenContext: {
      selectedText: "A sentence.", protectedText: "A sentence.", beforeSelection: "", afterSelection: "",
    } }, settings);
    expect(deepen.messages[0].content).not.toContain("<scholarpen_edit");
    expect(deepen.messages[0].content).not.toContain("active_document_edit_rules");
    expect(deepen.messages.map(message => message.content).join("\n")).not.toContain("[¶");

    const noProject = await buildAgentMessages({ ...request, projectPath: null }, settings);
    expect(noProject.messages[0].content).not.toContain("<scholarpen_edit");
    expect(noProject.messages[0].content).toContain("You are read-only");
  } finally { setDocumentEditGuide(null); }
});

test("a mentioned document that is also open is sent once, as the live snapshot", async () => {
  recall.mockResolvedValue([]);
  const request = await params();
  const path = join(request.projectPath!, "documents", "04_results.scholarpen.json");
  await mkdir(join(request.projectPath!, "documents"));
  await writeFile(path, JSON.stringify([{ type: "paragraph", content: [{ type: "text", text: "SAVED COPY" }] }]));
  files.mockResolvedValue([{ name: "documents", path: join(request.projectPath!, "documents"), isDirectory: true, kind: "folder", lastModified: 0,
    children: [{ name: "04_results.scholarpen.json", path, isDirectory: false, kind: "document", lastModified: 0 }] }] as any);
  // The scratch project is outside the configured project roots the real reader allows.
  const read = spyOn(fileSystem, "readTextFile").mockImplementation(async (filePath: string) => Bun.file(filePath).text());
  try {
    const result = await buildAgentMessages({ ...request, message: "@[documents/04_results.scholarpen.json] 비교해줘",
      activeDocument: snapshotActiveDocument(path, [{ type: "paragraph", content: [{ type: "text", text: "LIVE COPY" }] }]) }, settings);
    const all = result.messages.map(message => message.content).join("\n");
    expect(all).toContain('<mentioned_file path="documents/04_results.scholarpen.json" same_as="active_document" />');
    expect(all).toContain("LIVE COPY");
    expect(all).not.toContain("SAVED COPY");
  } finally { files.mockResolvedValue([]); read.mockRestore(); }
});
