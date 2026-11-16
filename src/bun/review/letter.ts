import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ReviewSession, RoundResult } from "../../shared/review-session/types";
import type { SessionStore } from "./session-store";
import { atomicWrite, exists, scopedPath, writeJSON } from "./workspace";

/**
 * The response letter of a completed session lives in its review record
 * (`<record>/letter/`: `response.json`, `response-to-reviewers.md`, and the
 * `.scholarpen/` sync record and backups), never beside a manuscript copy.
 */
const LETTER = "letter";
const ORIGIN = ".scholarpen/review-origin.json";
/** Letter files of the editable copies earlier versions made in `revisions/<session>/`. */
const LEGACY_FILES = ["response.json", "response-to-reviewers.md", ORIGIN, ".scholarpen/response-sync.json", ".scholarpen/response-backups"];

/** The session's letter folder, taking it over from an old `revisions/<session>/` copy when only that exists; null before there is one. */
export async function existingLetter(store: SessionStore, session: ReviewSession): Promise<string | null> {
  const root = await store.root(session.id);
  if (await exists(root, `${LETTER}/response.json`)) return scopedPath(root, LETTER);
  const legacy = `revisions/${session.id}`;
  if (!await exists(store.project, `${legacy}/response.json`)) return null;
  // Copied, not moved: the old copy stays as it was until the author removes it.
  const source = await scopedPath(store.project, legacy);
  const temp = await scopedPath(root, `.state/letter-${randomUUID()}`);
  try {
    await mkdir(temp, { recursive: true });
    for (const file of LEGACY_FILES) {
      if (!await exists(source, file)) continue;
      const target = await scopedPath(temp, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(await scopedPath(source, file), target, { recursive: true });
    }
    await rename(temp, await scopedPath(root, LETTER));
  } finally { await rm(temp, { recursive: true, force: true }); }
  return scopedPath(root, LETTER);
}

/** The session's letter folder, written from the review's final letter the first time it is needed. */
export async function ensureLetter(store: SessionStore, session: ReviewSession, result: RoundResult): Promise<string> {
  const existing = await existingLetter(store, session);
  if (existing) return existing;
  const root = await store.root(session.id);
  const temp = await scopedPath(root, `.state/letter-${randomUUID()}`);
  try {
    await mkdir(temp, { recursive: true });
    for (const name of ["response.json", "response-to-reviewers.md"]) {
      if (await exists(root, `final/${name}`)) await atomicWrite(temp, name, await readFile(await scopedPath(root, `final/${name}`)));
    }
    await writeJSON(temp, ORIGIN, { schemaVersion: 1, sessionId: session.id, round: result.round, baselineHash: result.packageHash });
    await rename(temp, await scopedPath(root, LETTER));
  } finally { await rm(temp, { recursive: true, force: true }); }
  return scopedPath(root, LETTER);
}

/** Checks that a letter belongs to this session's selected round. */
export async function letterMatches(letter: string, session: ReviewSession, result: RoundResult) {
  if (!await exists(letter, ORIGIN)) return false;
  const origin = JSON.parse(await readFile(await scopedPath(letter, ORIGIN), "utf8")) as { sessionId?: string; round?: number; baselineHash?: string };
  return origin.sessionId === session.id && origin.round === result.round && origin.baselineHash === result.packageHash;
}
