import { basename } from "path";
import type { KBSearchResult } from "../kb/search";

export function buildReferenceList(results: KBSearchResult[]): string {
  const lines = results.map((r, i) => {
    const title = r.title || r.docId;
    const fileName = basename(r.filePath);
    const encodedPath = r.filePath.split("/").map(encodeURIComponent).join("/");
    return `${i + 1}. **[${title}](https://x-sp-ref${encodedPath})** — \`${fileName}\``;
  });
  return `\n\n**References (${results.length})**\n${lines.join("\n")}`;
}
