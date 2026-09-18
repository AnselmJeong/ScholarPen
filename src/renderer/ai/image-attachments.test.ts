import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { imageAttachmentAdapter, imagesFromMessage } from "./image-attachments";
import { MAX_IMAGE_BYTES } from "../../shared/agent-images";
import type { PendingAttachment, ThreadMessage } from "@assistant-ui/react";

// Exercise the browser FileReader path used by both clipboard and file-picker files.
test("image files become distinct ready previews and complete vision attachments", async () => {
  const dom = new Window();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: dom.FileReader });
  try {
    const file = new dom.File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64")], "screenshot.png", { type: "image/png" });
    async function add(file: File) {
      const states: PendingAttachment[] = [];
      const result = imageAttachmentAdapter.add({ file });
      if (Symbol.asyncIterator in result) for await (const state of result) states.push(state);
      else states.push(await result);
      return states;
    }
    const states = await add(file as unknown as File);
    expect(states[0].status.type).toBe("running");
    const ready = states.at(-1)!;
    expect(ready.status.type).toBe("requires-action");
    expect(ready.content?.[0]).toMatchObject({ type: "image" });
    const second = (await add(file as unknown as File)).at(-1)!;
    expect(second.id).not.toBe(ready.id);
    const complete = await imageAttachmentAdapter.send(ready);
    const message: ThreadMessage = { id: "test", role: "user", createdAt: new Date(), content: [], attachments: [complete], metadata: { custom: {} } };
    expect(imagesFromMessage(message)[0]).toEqual({ name: "screenshot.png", dataUrl: `data:image/png;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}` });
    const oversized = new dom.File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "large.png", { type: "image/png" });
    const invalid = (await add(oversized as unknown as File)).at(-1)!;
    expect(invalid.status).toEqual({ type: "incomplete", reason: "error" });
    await expect(imageAttachmentAdapter.send(invalid)).rejects.toThrow("5 MB");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "FileReader", descriptor);
    else Reflect.deleteProperty(globalThis, "FileReader");
    await dom.happyDOM.abort();
  }
});
