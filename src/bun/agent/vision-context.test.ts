import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSettings } from "../fs/manager";
import { buildAgentMessages } from "./context-builder";
import { streamAgentModel } from "./providers";
import { AgentThreadStore } from "./thread-store";
import { restoredImageAttachments, imagesFromMessage } from "../../renderer/ai/image-attachments";
import { ACTIVE_DOCUMENT_LIMIT, snapshotActiveDocument } from "../../shared/active-document-context";
import { validateAgentImages, MAX_IMAGE_BYTES } from "../../shared/agent-images";
import type { AgentStreamParams } from "../../shared/rpc-types";
import type { ThreadMessage } from "@assistant-ui/react";

const image = { name: "screenshot.png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=" };
const settings = normalizeSettings({ ollamaApiKey: "test", openaiApiKey: "test", anthropicApiKey: "test", webSearchEnabled: false });
const params: AgentStreamParams = {
  message: "이 그림을 현재 원고와 연결해 설명해줘", images: [image], projectPath: null, history: [],
  provider: "ollama", model: "qwen3.5:397b", selectedSkillIds: [], selectedFilePaths: [], lang: "ko",
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("current image, historical image and unsaved structured document reach the Ollama vision request", async () => {
  const blocks = [{ type: "paragraph", content: [{ type: "text", text: "저장 전 수정한 논지" }, { type: "citation", props: { citekey: "smith2026" } }] },
    { type: "math", props: { formula: "E=mc^2" } }, { type: "figure", props: { url: image.dataUrl, caption: "도식" } }];
  const activeDocument = snapshotActiveDocument("documents/current.scholarpen.json", blocks);
  const result = await buildAgentMessages({ ...params, activeDocument, history: [{ role: "user", content: "", images: [image] }] }, settings);
  let requestBody = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requestBody = String(init?.body);
    return new Response('data: {"choices":[{"delta":{"content":"확인했습니다"}}]}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const chunks: string[] = [];
  for await (const chunk of streamAgentModel({ provider: "ollama", model: params.model, messages: result.messages }, settings)) chunks.push(chunk);
  const payload = JSON.parse(requestBody);
  expect(chunks).toEqual(["확인했습니다"]);
  expect(payload.messages.at(-1).content).toEqual([{ type: "text", text: params.message }, { type: "image_url", image_url: { url: image.dataUrl } }]);
  expect(payload.messages[1].content[1].image_url.url).toBe(image.dataUrl);
  expect(payload.messages.at(-2).content).toContain("저장 전 수정한 논지");
  expect(payload.messages.at(-2).content).toContain("smith2026");
  expect(payload.messages.at(-2).content).toContain("E=mc^2");
  expect(payload.messages.at(-2).content).not.toContain(image.dataUrl);
  expect(payload.messages[0].content).not.toContain("No project file content is provided");
});

test("each request uses the newest snapshot, and a closed document leaves no stale context", async () => {
  const blocks = [{ type: "paragraph", content: "old" }];
  const first = snapshotActiveDocument("a.scholarpen.json", blocks);
  blocks[0].content = "unsaved new";
  const second = snapshotActiveDocument("b.scholarpen.json", blocks);
  expect(first.content).toContain("old");
  const updated = await buildAgentMessages({ ...params, activeDocument: second }, settings);
  expect(updated.messages.at(-2)?.content).toContain("b.scholarpen.json");
  expect(updated.messages.at(-2)?.content).toContain("unsaved new");
  const closed = await buildAgentMessages(params, settings);
  expect(closed.messages.some((message) => message.content.includes("<active_document"))).toBeFalse();
});

test("large document context is bounded and visibly marked, preserving both ends", async () => {
  const activeDocument = snapshotActiveDocument("long.json", [{ content: "START" + "x".repeat(80_000) + "END" }]);
  expect(activeDocument.content.length).toBeLessThanOrEqual(ACTIVE_DOCUMENT_LIMIT);
  expect(activeDocument.truncated).toBeTrue();
  expect(activeDocument.content).toContain("START");
  expect(activeDocument.content).toContain("END");
  const result = await buildAgentMessages({ ...params, activeDocument }, settings);
  expect(result.messages.at(-2)?.content).toContain('truncated="true"');
});

test("image-only input works; ordinary text retains the text-only API shape", async () => {
  const vision = await buildAgentMessages({ ...params, message: "" }, settings);
  expect(vision.messages.at(-1)?.content).toContain("이미지");
  const plain = await buildAgentMessages({ ...params, images: undefined }, settings);
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    expect(payload.messages.at(-1)).toEqual({ role: "user", content: params.message });
    return new Response("data: [DONE]\n\n");
  }) as typeof fetch;
  for await (const _ of streamAgentModel({ provider: "ollama", model: params.model, messages: plain.messages }, settings)) { /* drain */ }
});

test("Claude receives image source blocks and OpenAI receives image_url blocks", async () => {
  for (const provider of ["anthropic", "openai"] as const) {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      const part = payload.messages[0].content[1];
      expect(part).toEqual(provider === "anthropic"
        ? { type: "image", source: { type: "base64", media_type: "image/png", data: image.dataUrl.split(",")[1] } }
        : { type: "image_url", image_url: { url: image.dataUrl } });
      return new Response("data: [DONE]\n\n");
    }) as typeof fetch;
    for await (const _ of streamAgentModel({ provider, model: "vision", messages: [{ role: "user", content: "Describe", images: [image] }] }, settings)) { /* drain */ }
  }
});

test("saved thread images survive database serialization and runtime restoration for follow-up questions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scholarpen-vision-"));
  try {
    const store = await new AgentThreadStore(directory).ready();
    const thread = store.createThread({ provider: "ollama", model: params.model });
    store.saveMessage({ threadId: thread.id, role: "user", content: "Describe", metadata: { images: [image] } });
    const saved = store.getThread(thread.id).messages[0];
    const message: ThreadMessage = {
      id: saved.id, role: "user", createdAt: new Date(saved.createdAt), content: [{ type: "text", text: saved.content }],
      attachments: restoredImageAttachments(saved.metadata?.images), metadata: { custom: {} },
    };
    expect(imagesFromMessage(message)).toEqual([image]);
    expect(restoredImageAttachments(undefined)).toEqual([]);
    expect(restoredImageAttachments([{ dataUrl: "file:///secret" }])).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reject invalid, oversized and excessive image payloads before provider submission", () => {
  expect(() => validateAgentImages(Array(5).fill(image))).toThrow("최대 4개");
  expect(() => validateAgentImages([{ ...image, dataUrl: "https://example.com/image.png" }])).toThrow();
  expect(() => validateAgentImages([{ ...image, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }])).toThrow();
  expect(() => validateAgentImages([{ ...image, dataUrl: "data:image/png;base64," + "a".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) }])).toThrow("5 MB");
});
