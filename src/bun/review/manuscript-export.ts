import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ReviewManuscriptExport } from "../../shared/review-session/types";
import { bundleExportImages } from "../fs/export-image-bundle";
import { atomicWrite, copyPackage, hash, manifest, scopedPath, writeJSON } from "./workspace";
import type { SessionStore } from "./session-store";

/** Export a sealed round. Conversion and image extraction never write into the sealed package. */
export async function exportReviewManuscripts(store: SessionStore, request: ReviewManuscriptExport): Promise<string> {
  if (!["json", "md", "qmd"].includes(request.format)) throw new Error("지원하지 않는 원고 내보내기 형식입니다.");
  const release = await store.lock(request.sessionId);
  let temporary: string | undefined;
  try {
    const session = await store.load(request.sessionId);
    const round = session.rounds.find(r => r.round === request.round);
    if (!Number.isInteger(request.round) || !round) throw new Error("검증 완료된 회차의 원고만 내보낼 수 있습니다.");
    const root = await store.root(session.id);
    const source = await scopedPath(root, `rounds/${String(round.round).padStart(2, "0")}/project`);
    if ((await manifest(source)).packageHash !== round.packageHash) throw new Error("봉인된 원고가 변경되었습니다. 내보내기를 중단했습니다.");
    if (request.format !== "json") {
      if (!Array.isArray(request.documents) || request.documents.length !== session.input.documents.length ||
          new Set(request.documents.map(d => d.filename)).size !== session.input.documents.length ||
          request.documents.some(d => !session.input.documents.includes(d.filename) || typeof d.content !== "string")) {
        throw new Error("선택한 회차의 모든 원고를 변환해야 합니다.");
      }
    }
    temporary = await scopedPath(root, `.state/manuscript-export-${randomUUID()}`);
    await mkdir(temporary);
    const project = join(temporary, "project");
    await copyPackage(source, project);
    let publishedSource = project;
    if (request.format !== "json") {
      // The existing serializer resolves images from a project's exports/ folder.
      // Bundle there in the temporary copy, then publish that portable folder.
      await mkdir(join(project, "exports"), { recursive: true });
      const names = request.documents.map(d => basename(d.filename).replace(/\.scholarpen\.json$/i, ""));
      const documents = request.documents.map((d, i) => {
        const stem = names[i]!;
        const duplicate = names.filter(n => n === stem).length > 1;
        const filename = `${stem}${duplicate ? `-${hash(d.filename).slice(0, 12)}` : ""}.${request.format}`;
        return { path: join(project, "exports", filename), content: d.content };
      });
      const prepared = await bundleExportImages(project, documents);
      for (const d of prepared) await atomicWrite(project, `exports/${basename(d.path)}`, d.content);
      publishedSource = join(project, "exports");
    }
    // A fresh publication folder preserves older exports and the source bibliography.
    const name = `review-${session.id}-r${round.round}-${request.format}-${randomUUID().slice(0, 8)}`;
    const exportsRoot = await scopedPath(store.project, "exports");
    await mkdir(exportsRoot, { recursive: true });
    const destination = await scopedPath(store.project, `exports/${name}`);
    const unpublished = await scopedPath(store.project, `exports/.${name}.tmp`);
    try {
      await copyPackage(publishedSource, unpublished);
      await writeJSON(unpublished, "review-export.json", {
        ...await manifest(unpublished), sessionId: session.id, round: round.round,
        format: request.format, sourcePackageHash: round.packageHash,
      });
      await rename(unpublished, destination);
    } catch (error) {
      await rm(unpublished, { recursive: true, force: true });
      throw error;
    }
    session.exportedPaths.push(destination);
    await store.save(session);
    return destination;
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    finally { await release(); }
  }
}
