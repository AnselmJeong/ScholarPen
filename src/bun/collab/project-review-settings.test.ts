import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { ProjectReviewSettingsStore, applyProjectReviewSettings } from "./project-review-settings";
import { REVIEW_MAP, reviewSettingsOf, normalizeReviewCategory, reviewCategoryLabel, REVIEW_CATEGORIES } from "../../shared/collab/review";

const roots: string[] = [];
const docs: Y.Doc[] = [];
afterEach(async () => {
  docs.splice(0).forEach(doc => doc.destroy());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "scholarpen-review-settings-"));
  roots.push(root);
  return root;
}
function session(projectPath: string) {
  const ydoc = new Y.Doc(); docs.push(ydoc);
  return { projectPath, ydoc };
}

test("canonical categories merge citation labels and reject unknown model types", () => {
  for (const label of ["citation", "missing-citation", "Needs citation", "need_citation"]) {
    expect(normalizeReviewCategory(label)).toBe("citation");
    expect(reviewCategoryLabel(label)).toBe("Citation");
  }
  expect(normalizeReviewCategory("creative-new-type")).toBeNull();
  expect(normalizeReviewCategory("draft")).toBeNull();
  expect(new Set(REVIEW_CATEGORIES.map(c => c.id)).size).toBe(REVIEW_CATEGORIES.length);
});

test("project toggles persist across restart and do not affect another project", async () => {
  const a = await project(); const b = await project();
  const store = new ProjectReviewSettingsStore();
  expect(await store.get(a)).toEqual({ disabledCategories: [] });
  await store.setCategory(a, "missing-citation", false);
  const restarted = new ProjectReviewSettingsStore();
  expect(await restarted.get(a)).toEqual({ disabledCategories: ["citation"] });
  expect(await restarted.get(b)).toEqual({ disabledCategories: [] });
  await restarted.setCategory(a, "citation", true);
  expect(JSON.parse(await readFile(join(a, ".scholarpen/review-settings.json"), "utf8"))).toEqual({ disabledCategories: [] });
});

test("simultaneous toggles in separate editors cannot discard each other", async () => {
  const root = await project(); const store = new ProjectReviewSettingsStore();
  await Promise.all([store.setCategory(root, "logic", false), store.setCategory(root, "citation", false)]);
  expect((await store.get(root)).disabledCategories).toEqual(["logic", "citation"]);
  await expect(store.setCategory(root, "unrecognized", false)).rejects.toThrow("Unknown");
  expect((await store.get(root)).disabledCategories).toEqual(["logic", "citation"]);
});

test("live project policy updates every same-project editor and supersedes legacy local mutes", () => {
  const a = session("/a"), a2 = session("/a"), b = session("/b");
  a.ydoc.getMap(REVIEW_MAP).set("muted", ["logic"]);
  applyProjectReviewSettings([a, a2, b], "/a", { disabledCategories: ["citation"] });
  expect(reviewSettingsOf(a.ydoc.getMap(REVIEW_MAP)).muted).toEqual(["citation"]);
  expect(reviewSettingsOf(a2.ydoc.getMap(REVIEW_MAP)).muted).toEqual(["citation"]);
  expect(reviewSettingsOf(b.ydoc.getMap(REVIEW_MAP)).muted).toEqual([]);
  const reopened = session("/a");
  Y.applyUpdate(reopened.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  expect(reviewSettingsOf(reopened.ydoc.getMap(REVIEW_MAP)).muted).toEqual(["citation"]);
});

test("corrupt settings fail visibly instead of silently turning all types back on", async () => {
  const root = await project();
  await mkdir(join(root, ".scholarpen"));
  const path = join(root, ".scholarpen/review-settings.json");
  await writeFile(path, '{"disabledCategories":false}');
  const store = new ProjectReviewSettingsStore();
  await expect(store.get(root)).rejects.toThrow("Invalid project review settings");
  await expect(store.setCategory(root, "logic", false)).rejects.toThrow("Invalid project review settings");
  expect(await readFile(path, "utf8")).toBe('{"disabledCategories":false}');
});
