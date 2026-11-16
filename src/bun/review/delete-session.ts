import { existsSync } from "node:fs";
import { mkdir, realpath, rename } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { homedir } from "node:os";
import type { ReviewAddress, ReviewSession } from "../../shared/review-session/types";
import { OPEN_PROPOSAL_STATES, type ProposalState } from "../../shared/collab/review-proposals";
import { reviewEngine } from "./service";
import { readStagedProposals } from "./proposals";
import { responseSyncStatus } from "./manuscript-proposals";
import { openDocumentProjects } from "./decision-sources";
import { exists, scopedPath } from "./workspace";
import type { SessionStore } from "./session-store";

export interface ReviewDeletion { trashed: string[] }

/**
 * Moves a file or folder to the macOS Trash. On the home volume (which includes
 * Google Drive and other cloud folders, where `/usr/bin/trash` can wait forever
 * on the file provider) it is renamed into `~/.Trash`; elsewhere `/usr/bin/trash`
 * gets 30 s. Failing both, it goes to the project's `.scholarpen/trash/`.
 */
export async function moveToTrash(path: string, project: string, options: { trashDir?: string; command?: string | null } = {}): Promise<void> {
  const { trashDir = join(homedir(), ".Trash"), command = "/usr/bin/trash" } = options;
  const name = `${basename(path)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try { await rename(path, join(trashDir, name)); return; }
  catch (error) { if (!["EXDEV", "ENOENT", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  if (command && existsSync(command)) {
    const child = Bun.spawn([command, path], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 30_000);
    const code = await child.exited.finally(() => clearTimeout(timer));
    if (code === 0 && !existsSync(path)) return;
  }
  const folder = join(project, ".scholarpen", "trash");
  await mkdir(folder, { recursive: true });
  await rename(path, join(folder, name));
}

/** Proposals of a session still shown in the manuscript (undecided, being rewritten, or unplaced cards). */
async function openProposals(store: SessionStore, session: ReviewSession): Promise<number> {
  const staged = await readStagedProposals(store.project, session.id).catch(() => null);
  if (!staged?.proposals.length) return 0;
  const status = await responseSyncStatus(store, session);
  return status?.proposals.filter(item => OPEN_PROPOSAL_STATES.has(item.state as ProposalState)).length ?? 0;
}

export interface DeleteDeps {
  trash: (path: string, project: string) => Promise<void>;
  /** Project folders of the documents open in an editor. */
  openProjects: () => string[];
  openProposals: (store: SessionStore, session: ReviewSession) => Promise<number>;
}

/**
 * Deletes a review session the author no longer wants: its review record
 * with its letter, a revision copy left by an earlier version
 * (`revisions/<id>/`) and its staged proposals go to the Trash. The manuscript (`documents/`) and files
 * already exported to `exports/` are never touched.
 */
export async function deleteReviewSession(a: ReviewAddress, deps: Partial<DeleteDeps> = {}): Promise<ReviewDeletion> {
  const { trash = moveToTrash, openProjects = openDocumentProjects } = deps;
  const engine = await reviewEngine(a.projectPath);
  const project = engine.store.project;
  const session = await engine.store.load(a.sessionId);
  if (session.status === "running" || engine.isActive(session.id)) throw new Error("검토가 진행 중인 세션은 삭제할 수 없습니다. 먼저 일시정지하거나 실행을 취소해 주세요.");

  const open = await (deps.openProposals ?? openProposals)(engine.store, session);
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
