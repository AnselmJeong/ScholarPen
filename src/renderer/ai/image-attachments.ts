import type { AttachmentAdapter, PendingAttachment, ThreadMessage } from "@assistant-ui/react";
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, validateAgentImages } from "@shared/agent-images";
import type { AgentImage } from "@shared/rpc-types";

export const imageAttachmentAdapter: AttachmentAdapter = {
  accept: IMAGE_ACCEPT,
  async *add({ file }) {
    const base = { id: crypto.randomUUID(), type: "image", name: file.name, contentType: file.type, file };
    if (!IMAGE_ACCEPT.split(",").includes(file.type) || file.size > MAX_IMAGE_BYTES || file.size === 0) {
      yield { ...base, status: { type: "incomplete", reason: "error" } } satisfies PendingAttachment;
      return;
    }
    yield { ...base, status: { type: "running", reason: "uploading", progress: 0 } } satisfies PendingAttachment;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Image read failed"));
        reader.onerror = () => reject(new Error("Image read failed"));
        reader.onabort = () => reject(new Error("Image read cancelled"));
        reader.readAsDataURL(file);
      });
      validateAgentImages([{ name: file.name, dataUrl }]);
      yield { ...base, content: [{ type: "image", image: dataUrl }], status: { type: "requires-action", reason: "composer-send" } } satisfies PendingAttachment;
    } catch {
      yield { ...base, status: { type: "incomplete", reason: "error" } } satisfies PendingAttachment;
    }
  },
  async send(attachment) {
    if (attachment.status.type !== "requires-action" || !attachment.content?.length) {
      throw new Error("이미지를 읽지 못했습니다. PNG, JPEG, WebP, GIF 형식의 5 MB 이하 파일을 다시 첨부해 주세요.");
    }
    return { ...attachment, status: { type: "complete" }, content: attachment.content };
  },
  async remove() {},
};

export function imagesFromMessage(message: ThreadMessage): AgentImage[] {
  if (message.role !== "user") return [];
  const images: AgentImage[] = [];
  for (const part of message.content) {
    if (part.type === "image") images.push({ name: "Image", dataUrl: part.image });
  }
  for (const attachment of message.attachments ?? []) {
    for (const part of attachment.content) {
      if (part.type === "image") images.push({ name: attachment.name, dataUrl: part.image });
    }
  }
  return validateAgentImages(images);
}

export function restoredImageAttachments(value: unknown) {
  let images: AgentImage[];
  try { images = validateAgentImages(value); } catch { return []; }
  return images.map((image, index) => ({
    id: `saved-image-${index}`,
    type: "image",
    name: image.name,
    status: { type: "complete" as const },
    content: [{ type: "image" as const, image: image.dataUrl }],
  }));
}
