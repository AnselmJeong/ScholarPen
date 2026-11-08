import { BlockNoteEditor } from "@blocknote/core";
import { scholarSchema } from "../../blocks/schema";
import { blocksToScholarMarkdown, documentTitleFromFilename } from "../../blocks/markdown-serializer";
import { rpc } from "../../rpc";
import type { ReviewAddress, ReviewExportFormat } from "../../../shared/review-session/types";
function createSerializer() { return BlockNoteEditor.create({ schema: scholarSchema }); }
let serializer: ReturnType<typeof createSerializer> | undefined;

export async function exportManuscripts(address: ReviewAddress, round: number, format: ReviewExportFormat) {
  if (format === "json") return rpc.reviewExportManuscripts({ ...address, round, format });
  const value: unknown = JSON.parse(await rpc.reviewManuscript(address, round));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("리뷰 원고를 읽을 수 없습니다.");
  const editor = serializer ??= createSerializer();
  const documents: { filename: string; content: string }[] = [];
  for (const [filename, blocks] of Object.entries(value)) {
    if (!Array.isArray(blocks)) throw new Error(`올바르지 않은 원고: ${filename}`);
    // The backend only returns sealed, validated ScholarPen block arrays.
    const content = await blocksToScholarMarkdown(editor, blocks as Parameters<typeof blocksToScholarMarkdown>[1], format,
      documentTitleFromFilename(filename.split("/").at(-1)!), { filename: filename.replace(/\.scholarpen\.json$/i, `.${format}`) });
    documents.push({ filename, content });
  }
  return rpc.reviewExportManuscripts({ ...address, round, format, documents });
}
