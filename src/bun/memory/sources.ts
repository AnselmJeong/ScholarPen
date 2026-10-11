import { readdir, readFile } from "fs/promises";
import { join } from "path";
import * as Y from "yjs";
import { AUTHOR_EDITS_MAP, type AuthorObservation } from "../../shared/author-learning";

export interface MemorySource { key: string; content: string; context: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function files(root: string, prefix: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(join(root, prefix), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

/** Existing prose and AI-generated edits alone do not prove the author's preference. */
export async function collectAuthorObservations(root: string): Promise<AuthorObservation[]> {
  const observations: AuthorObservation[] = [];
  for (const path of await files(root, ".scholarpen/collab")) {
    if (!path.endsWith(".ydoc")) continue;
    const filename = path.replace(/^\.scholarpen\/collab\//, "").replace(/\.ydoc$/, "");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, new Uint8Array(await readFile(join(root, path))));
      for (const [id, value] of doc.getMap<unknown>(AUTHOR_EDITS_MAP)) {
        if (!record(value) || typeof value.blockId !== "string" || typeof value.before !== "string" ||
            typeof value.after !== "string" || typeof value.observedAt !== "number" || value.before === value.after) continue;
        if (Date.now() - value.observedAt < 60_000) continue;
        observations.push({ id: `${filename}:edit:${id}`, filename, kind: "direct-edit", direction: "",
          blockId: value.blockId, before: value.before, after: value.after, observedAt: value.observedAt });
      }
      for (const [id, value] of doc.getMap<unknown>("revisions")) {
        if (!record(value) || (value.status !== "accepted" && value.status !== "rejected") || !Array.isArray(value.paragraphs)) continue;
        const items = Array.isArray(value.items) ? value.items.filter(record) : [];
        const direction = items.filter(item => item.commentBy === "author" && typeof item.comment === "string")
          .map(item => String(item.comment)).join("\n");
        for (const paragraph of value.paragraphs) {
          if (!record(paragraph) || typeof paragraph.blockId !== "string" || typeof paragraph.before !== "string" || typeof paragraph.after !== "string") continue;
          observations.push({ id: `${filename}:revision:${id}:${paragraph.blockId}`, filename, kind: value.status, direction,
            blockId: paragraph.blockId, before: paragraph.before, after: paragraph.after,
            observedAt: typeof value.decidedAt === "number" ? value.decidedAt : Number(value.createdAt) || 0 });
        }
      }
    } finally { doc.destroy(); }
  }
  return observations.sort((a, b) => b.observedAt - a.observedAt);
}

export async function collectMemorySources(root: string): Promise<MemorySource[]> {
  return (await collectAuthorObservations(root)).map(observation => ({
    key: observation.id,
    content: `Observed author action: ${observation.kind}.\nBefore: ${observation.before}\n${observation.kind === "rejected" ? "Rejected AI proposal" : "After"}: ${observation.after}\nAuthor request: ${observation.direction || "No explicit reason recorded."}\nThis is one editing observation, not an established preference or scholarly evidence. Rejection does not establish the opposite preference.`,
    context: `ScholarPen author editing observation in ${observation.filename}, paragraph ${observation.blockId}`,
  }));
}
