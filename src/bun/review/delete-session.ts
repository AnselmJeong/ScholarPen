import { existsSync } from "node:fs";
import { mkdir, realpath, rename } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import type { ReviewAddress, ReviewSession } from "../../shared/review-session/types";
import { OPEN_PROPOSAL_STATES, type ProposalState } from "../../shared/collab/review-proposals";
import { reviewEngine } from "./service";
import { readStagedProposals } from "./proposals";
import { responseSyncStatus } from "./manuscript-proposals";
import { openDocumentProjects } from "./decision-sources";
import { exists, scopedPath } from "./workspace";

export interface ReviewDeletion { trashed: string[] }

/** Moves a file or folder to the macOS Trash, or (without `/usr/bin/trash`) to the project's `.scholarpen/trash/`. */
export async function moveToTrash(path: string, project: string): Promise<void> {
  if (existsSync("/usr/bin/trash")) {
    const child = Bun.spawn(["/usr/bin/trash", path], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) return;
    throw new Error(`휴지통으로 옮기지 못했습니다: ${stderr.trim() || `exit ${code}`}`);
  }
  const folder = join(project, ".scholarpen", "trash");
  await mkdir(folder, { recursive: true });
  await rename(path, join(folder, `${basename(path)}-${Date.now()}`));
}

/** Proposals of a session still shown in the manuscript (undecided, being rewritten, or unplaced cards). */
async function openProposals(project: string, session: ReviewSession): Promise<number> {
  const staged = await readStagedProposals(project, session.id).catch(() => null);
  if (!staged?.proposals.length) return 0;
  const status = await responseSyncStatus(project, session);
  return status?.proposals.filter(item => OPEN_PROPOSAL_STATES.has(item.state as ProposalState)).length ?? 0;
}

export interface DeleteDeps {
  trash: (path: string, project: string) => Promise<void>;
  /** Project folders of the documents open in an editor. */
  openProjects: () => string[];
  openProposals: (project: string, session: ReviewSession) => Promise<number>;
}

/**
 * Deletes a review session the author no longer wants: its review record
 * (`reviews/<id>/`), its revision copy and letter (`revisions/<id>/`) and its
 * staged proposals go to the Trash. The manuscript (`documents/`) and files
 * already exported to `exports/` are never touched.
 */
export async function deleteReviewSession(a: ReviewAddress, deps: Partial<DeleteDeps> = {}): Promise<ReviewDeletion> {
  const { trash = moveToTrash, openProjects = openDocumentProjects } = deps;
  const engine = await reviewEngine(a.projectPath);
  const project = engine.store.project;
  const session = await engine.store.load(a.sessionId);
  if (session.status === "running" || engine.isActive(session.id)) throw new Error("검토가 진행 중인 세션은 삭제할 수 없습니다. 먼저 일시정지하거나 실행을 취소해 주세요.");

  const open = await (deps.openProposals ?? openProposals)(project, session);
  if (open) throw new Error(`이 세션의 수정안 ${open}개가 아직 원고에 표시되어 있습니다. 원고 여백의 카드에서 모두 확인하거나 거절한 뒤 삭제해 주세요.`);

  const revision = `revisions/${session.id}`;
  const revisionPath = await exists(project, revision) ? await scopedPath(project, revision) : null;
  if (revisionPath) {
    const inside = (path: string) => path === revisionPath || path.startsWith(revisionPath + sep);
    for (const path of openProjects()) {
      if (inside(await realpath(path).catch(() => path))) throw new Error("이 세션의 수정 사본 문서가 편집기에 열려 있습니다. 문서를 닫은 뒤 삭제해 주세요.");
    }
  }

  // Waits for (and fails on) any writer still holding the session.
  const root = await engine.store.root(session.id);
  await (await engine.store.lock(session.id))();

  const staged = `.scholarpen/review-proposals/${session.id}.json`;
  const targets = [
    ...(revisionPath ? [revisionPath] : []),
    ...(await exists(project, staged) ? [await scopedPath(project, staged)] : []),
    root, // last, so a failed move leaves the session listed
  ];
  const trashed: string[] = [];
  for (const path of targets) {
    if (!existsSync(path)) continue;
    await trash(path, project);
    trashed.push(path);
  }
  return { trashed };
}
