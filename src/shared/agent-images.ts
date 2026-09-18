import type { AgentImage, OllamaMessage } from "./rpc-types";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGES = 4;

export function validateAgentImages(value: unknown): AgentImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_IMAGES) {
    throw new Error(`이미지는 한 질문에 최대 ${MAX_MESSAGE_IMAGES}개까지 첨부할 수 있습니다.`);
  }
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("name" in item) || !("dataUrl" in item)
      || typeof item.name !== "string" || typeof item.dataUrl !== "string") {
      throw new Error("이미지 첨부 형식이 올바르지 않습니다.");
    }
    if (item.dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) {
      throw new Error("이미지는 각각 5 MB 이하로 첨부해 주세요.");
    }
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.dataUrl)) {
      throw new Error("PNG, JPEG, WebP, GIF 이미지만 첨부할 수 있습니다.");
    }
    return { name: item.name, dataUrl: item.dataUrl };
  });
}

export function openAIImageMessages(messages: OllamaMessage[]) {
  return messages.map(({ role, content, images }) => {
    const validImages = validateAgentImages(images);
    return {
      role,
      content: validImages.length > 0
        ? [
            { type: "text" as const, text: content },
            ...validImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } })),
          ]
        : content,
    };
  });
}
