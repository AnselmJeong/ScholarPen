import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewEngine, type ReviewModelRequest } from "./orchestrator";
import { SessionStore } from "./session-store";
import * as Y from "yjs";
import { manuscriptHash } from "../collab/registry";
import { snapshot } from "./workspace";
import { exportReviewManuscripts } from "./manuscript-export";
import { context, describeDocument } from "./context";
import { hash, manifest, scopedPath, writeJSON } from "./workspace";
import { applyPatches, validateResponses } from "./patches";
import { parseInput } from "../../shared/review-session/schema";
import { DEFAULT_REVIEWERS, type ReviewInput, type ReviewComment } from "../../shared/review-session/types";
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const blocks = [
  { id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "These findings prove causality.", styles: {} }, { type: "citation", props: { citekey: "smith2020" } }], children: [] },
  { id: "t1", type: "table", props: { caption: "Sample counts" }, content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "Group", styles: {} }], [{ type: "text", text: "Count", styles: {} }]] }, { cells: [[{ type: "text", text: "A", styles: {} }], [{ type: "text", text: "10", styles: {} }]] }, { cells: [[{ type: "text", text: "B", styles: {} }], [{ type: "text", text: "20", styles: {} }]] }, { cells: [[{ type: "text", text: "Total", styles: {} }], [{ type: "text", text: "35", styles: {} }]] }] }, children: [] },
];
const comment: ReviewComment = { id: "R1-C01", reviewerId: "R1", original: "Please avoid causal claims.", targets: [], severity: "major", source: "human" };
async function fixture(figures = 0) {
  const root = await mkdtemp(join(tmpdir(), "scholar-review-")); roots.push(root); await mkdir(join(root, "documents")); await mkdir(join(root, "exports")); await mkdir(join(root, "figures"));
  const doc: unknown[] = structuredClone(blocks);
  for (let i = 0; i < figures; i++) { const sourcePath = `figures/plot-${i}.png`; await writeFile(join(root, sourcePath), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEkAAAAASUVORK5CYII=", "base64")); doc.push({ id: `f${i}`, type: "figure", props: { sourcePath, caption: `Plot ${i}` }, content: [], children: [] }); }
  await writeFile(join(root, "documents/paper.scholarpen.json"), JSON.stringify(doc)); await writeFile(join(root, "exports/references.bib"), "@article{smith2020,title={Study},year={2020}}\n");
  const input: ReviewInput = { projectPath: root, documents: ["paper.scholarpen.json"], mode: "peer", maxCycles: 2, reviewerModel: "gpt-test", reviserModel: "claude-test", reviewers: [{ ...DEFAULT_REVIEWERS[0]!, original: comment.original }], decisionLetter: "", language: "English", authorConstraints: "Observational study", baselineNote: "Submitted version" };
  return { root, input };
}
function fakeProvider(options: { alwaysRevise?: boolean; failResponse?: boolean; figures?: boolean; figureRequest?: boolean; invalidJSON?: boolean } = {}) {
  const calls: ReviewModelRequest[] = []; let fail = Boolean(options.failResponse);
  const complete = async (r: ReviewModelRequest) => {
    calls.push(r); const round = Number(r.stage.split("-").at(-1)) || 1;
    if (r.stage === "manuscript-contract") return JSON.stringify({ question: "Association", claims: [], design: ["Observational"], results: [], terms: [], argumentMap: "Methods → Results → Interpretation", uncertainties: [] });
    if (r.stage.includes("figures-")) return JSON.stringify({ findings: r.images.map(i => ({ figureId: i.name, assessment: "Pixels checked", limitations: "No raw data" })) });
    if (r.stage.startsWith("initial-")) return JSON.stringify({ comments: [{ original: "Avoid causal claims", targets: ["p1"], severity: "major" }] });
    if (r.stage.startsWith("plan-")) {
      if (options.invalidJSON) return "{truncated";
      return JSON.stringify({ principles: ["Preserve observed facts"], argumentMap: "Methods → Results → Interpretation", conflicts: [], patches: round === 1 ? [{ kind: "set-text", id: "p1", slotId: "paper.scholarpen.json#p1:0/content/0/text", before: "These findings prove causality.", after: "These findings indicate an association.", commentIds: ["R1-C01"], rationale: "Observational evidence" }] : [], figures: options.figureRequest && round === 1 ? [{ figureId: "paper.scholarpen.json#f0", specification: "Increase axis label size", commentIds: ["R1-C01"] }] : [], decisions: [{ commentId: "R1-C01", disposition: "changed", reason: "Association, not causality" }] });
    }
    if (r.stage.startsWith("responses-")) {
      if (fail) { fail = false; throw new Error("Simulated subscription limit"); }
      return JSON.stringify({ responses: [{ commentId: "R1-C01", disposition: options.figureRequest ? "partially-addressed" : "changed", response: "We clarified the association; causal conclusions are not supported.", changeIds: ["C1-p1"], locations: ["paper.scholarpen.json#p1"] }] });
    }
    if (r.stage.startsWith("assessment-")) return JSON.stringify({ needsRevision: Boolean(options.alwaysRevise), regression: false, summary: "Internal review complete", issues: options.alwaysRevise ? ["previous-comment-followup: further clarity could help"] : [], comments: [{ commentId: "R1-C01", verification: "verified", reason: "Actual applied text matches" }] });
    throw new Error(`Unexpected stage ${r.stage}`);
  };
  return { calls, check: async () => ({ codex: "fixture", anthropic: "fixture" }), complete };
}
test("review JSON exports preserve revised bytes and dependencies without overwriting earlier exports", async () => {
  const { root, input } = await fixture(1);
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider());
  const session = await engine.create(input); await engine.start(session.id); await engine.wait(session.id);
  const source = join(await engine.store.root(session.id), "rounds/01/project");
  const before = await manifest(source);
  const request = { projectPath: root, sessionId: session.id, round: 1, format: "json" as const };
  const first = await exportReviewManuscripts(engine.store, request);
  const second = await exportReviewManuscripts(engine.store, request);
  expect(first.startsWith(join(await realpath(root), "exports") + "/")).toBe(true);
  expect(first).not.toBe(second);
  for (const output of [first, second]) {
    for (const file of before.files) expect(hash(await readFile(join(output, file.path)))).toBe(file.hash);
    expect(await readFile(join(output, "documents/paper.scholarpen.json"), "utf8")).toContain("indicate an association");
  }
  expect(await manifest(source)).toEqual(before);
  expect(await readFile(join(root, "documents/paper.scholarpen.json"), "utf8")).toContain("prove causality");
  expect((await engine.store.load(session.id)).exportedPaths).toEqual([first, second]);
});

test("snapshot ignores newer review metadata while detecting actual unsaved manuscript changes", async () => {
  const { root } = await fixture();
  const doc = new Y.Doc(); const paragraph = new Y.XmlElement("paragraph"); const text = new Y.XmlText("Saved manuscript");
  paragraph.push([text]); doc.getXmlFragment("document-store").push([paragraph]);
  const jsonContentHash = manuscriptHash(doc);
  doc.getMap("review").set("checked", true);
  text.format(0, 5, { comment: { threadId: "thread" } });
  const state = ".scholarpen/collab/paper.scholarpen.json.ydoc";
  await mkdir(join(root, ".scholarpen/collab"), { recursive: true });
  await writeFile(join(root, state), Y.encodeStateAsUpdate(doc));
  await writeJSON(root, state + ".meta.json", { jsonContentHash, updatedAt: 99999, jsonSavedAt: 1 });
  await snapshot(root, join(root, "reviews/valid"), ["paper.scholarpen.json"]);
  text.insert(0, "Unsaved ");
  await writeFile(join(root, state), Y.encodeStateAsUpdate(doc));
  await expect(snapshot(root, join(root, "reviews/invalid"), ["paper.scholarpen.json"])).rejects.toThrow("paper.scholarpen.json");
  doc.destroy();
});

test("review Markdown and Quarto exports bundle figures and snapshot bibliography independently", async () => {
  const { root, input } = await fixture(1);
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider());
  const session = await engine.create(input); await engine.start(session.id); await engine.wait(session.id);
  const source = join(await engine.store.root(session.id), "rounds/01/project");
  const before = await manifest(source);
  await writeFile(join(root, "exports/references.bib"), "new unrelated bibliography");
  for (const format of ["md", "qmd"] as const) {
    const output = await exportReviewManuscripts(engine.store, {
      projectPath: root, sessionId: session.id, round: 1, format,
      documents: [{ filename: "paper.scholarpen.json", content: "---\nbibliography: references.bib\n---\n\n![](../figures/plot-0.png)\n\n[@smith2020]\n" }],
    });
    expect(await readFile(join(output, `paper.${format}`), "utf8")).toContain("![](figures/plot-0.png)");
    expect(await readFile(join(output, "figures/plot-0.png"))).toEqual(await readFile(join(source, "figures/plot-0.png")));
    expect(await readFile(join(output, "references.bib"), "utf8")).toContain("smith2020");
  }
  expect(await manifest(source)).toEqual(before);
  expect(await readFile(join(root, "exports/references.bib"), "utf8")).toBe("new unrelated bibliography");
});

test("review exports reject missing rounds, incomplete document sets and changed snapshots", async () => {
  const { root, input } = await fixture();
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider());
  const session = await engine.create(input); await engine.start(session.id); await engine.wait(session.id);
  const request = { projectPath: root, sessionId: session.id, round: 1, format: "json" as const };
  await expect(exportReviewManuscripts(engine.store, { ...request, round: 2 })).rejects.toThrow("검증 완료");
  await expect(exportReviewManuscripts(engine.store, { ...request, format: "qmd", documents: [] })).rejects.toThrow("모든 원고");
  const source = join(await engine.store.root(session.id), "rounds/01/project");
  await writeFile(join(source, "documents/paper.scholarpen.json"), "[]");
  await expect(exportReviewManuscripts(engine.store, request)).rejects.toThrow("봉인된 원고");
  expect(await readdir(join(root, "exports"))).toEqual(["references.bib"]);
});

test("nested manuscripts with equal basenames export to distinct files", async () => {
  const { root, input } = await fixture();
  await mkdir(join(root, "documents/supplement"));
  await writeFile(join(root, "documents/supplement/paper.scholarpen.json"), JSON.stringify([{ id: "supp", type: "paragraph", content: [{ type: "text", text: "Supplement", styles: {} }], children: [] }]));
  input.documents.push("supplement/paper.scholarpen.json");
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider());
  const session = await engine.create(input); await engine.start(session.id); await engine.wait(session.id);
  const output = await exportReviewManuscripts(engine.store, {
    projectPath: root, sessionId: session.id, round: 1, format: "md",
    documents: input.documents.map((filename, i) => ({ filename, content: `Document ${i}` })),
  });
  const files = (await readdir(output)).filter(f => f.endsWith(".md"));
  expect(files).toHaveLength(2);
  expect((await Promise.all(files.map(f => readFile(join(output, f), "utf8")))).sort()).toEqual(["Document 0", "Document 1"]);
});

test("actual peer review: immutable source, cumulative response, hard two-cycle cap and durable final package", async () => {
  const { root, input } = await fixture(); const original = await manifest(root); const provider = fakeProvider({ alwaysRevise: true }); const engine = new ReviewEngine(new SessionStore(root), provider);
  const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  expect(done.status).toBe("completed"); expect(done.allocatedCycles).toBe(2); expect(done.completedCycles).toBe(2);
  expect(provider.calls.filter(c => c.stage.startsWith("plan-")).length).toBe(2); expect(done.rounds[1]!.responses[0]!.changeIds).toEqual(["C1-p1"]);
  const sr = await engine.store.root(s.id); expect((await manifest(join(sr, "original/project"))).packageHash).toBe(done.manifest.packageHash);
  for (const file of original.files) expect(hash(await readFile(join(root, file.path)))).toBe(file.hash);
  expect(await readFile(join(sr, "final/response-to-reviewers.md"), "utf8")).toContain(comment.original);
  await expect(engine.start(s.id)).rejects.toThrow("종료된");
});
test("virtual reviewers are independent, early completion uses one cycle", async () => {
  const { root, input } = await fixture(); input.mode = "virtual"; const provider = fakeProvider(); const engine = new ReviewEngine(new SessionStore(root), provider);
  const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  expect(done.status).toBe("completed"); expect(done.completedCycles).toBe(1); expect(provider.calls.filter(c => c.stage.startsWith("initial-")).length).toBe(1);
  expect(provider.calls.find(c => c.stage === "initial-R1")!.prompt).not.toContain('"reviewerId"');
});
test("failed response resumes from disk without reserving another cycle or reapplying edits", async () => {
  const { root, input } = await fixture(); const provider = fakeProvider({ failResponse: true }); const first = new ReviewEngine(new SessionStore(root), provider);
  const s = await first.create(input); await first.start(s.id); expect((await first.wait(s.id)).status).toBe("failed");
  const second = new ReviewEngine(new SessionStore(root), provider); await second.start(s.id); const done = await second.wait(s.id);
  expect(done.status).toBe("completed"); expect(done.allocatedCycles).toBe(1); expect(provider.calls.filter(c => c.stage === "plan-1").length).toBe(1); expect(done.rounds[0]!.changes).toHaveLength(1);
});
test("more than four figures are sent as actual image batches and recorded", async () => {
  const { root, input } = await fixture(5); const provider = fakeProvider(); const engine = new ReviewEngine(new SessionStore(root), provider); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  expect(done.status).toBe("completed"); const visual = provider.calls.filter(c => c.images.length); expect(visual.map(c => c.images.length)).toEqual([4, 1, 4, 1]); expect(done.rounds[0]!.coverage.filter(c => c.target.includes("#f") && c.status === "read")).toHaveLength(5);
});
test("missing replacement figures keep the original and finish with author follow-up", async () => {
  const { root, input } = await fixture(1); const provider = fakeProvider({ figureRequest: true });
  const original = await readFile(join(root, "figures/plot-0.png"));
  const engine = new ReviewEngine(new SessionStore(root), provider); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  expect(done.status).toBe("completed"); expect(done.quality).toBe("needs-author-action");
  expect(provider.calls.some(c => c.stage === "responses-1")).toBe(true);
  expect(done.rounds[0]!.authorChecks!.filter(c => c.kind === "figure")).toHaveLength(1);
  const sr = await engine.store.root(s.id);
  expect(await readFile(join(sr, "final/project/figures/plot-0.png"))).toEqual(original);
  expect(await readFile(join(root, "figures/plot-0.png"))).toEqual(original);
  expect(await readFile(join(sr,"final/response-to-reviewers.md"),"utf8")).toContain("figure revision has NOT been applied");
});
test("legacy paused session with approval but no image resumes without pausing again", async () => {
  const {root,input}=await fixture(1); const provider=fakeProvider({figureRequest:true,failResponse:true});
  const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);const paused=await engine.wait(s.id);
  paused.status="paused";paused.stage="awaiting-figure-approval(1)";paused.approvals[0]!.status="approved";await engine.store.save(paused);
  const resumed=new ReviewEngine(new SessionStore(root),provider);await resumed.start(s.id);const done=await resumed.wait(s.id);
  expect(done.status).toBe("completed");expect(done.allocatedCycles).toBe(1);expect(done.rounds[0]!.authorChecks!.filter(c=>c.kind==="figure")).toHaveLength(1);
  expect(done.rounds[0]!.changes.some(c=>c.id.includes("figure"))).toBe(false);
});
test("malformed plan exhausts bounded repairs then finishes with honest author follow-up", async () => {
  const { root, input } = await fixture(); const provider = fakeProvider({ invalidJSON: true });
  const engine = new ReviewEngine(new SessionStore(root), provider); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  expect(done.status).toBe("completed"); expect(done.quality).toBe("needs-author-action");
  expect(provider.calls.filter(c => c.stage === "plan-1")).toHaveLength(3);
  expect(done.rounds[0]!.changes).toHaveLength(0); expect(done.warnings!.some(w => w.stage === "plan-1")).toBe(true);
  expect(await readFile(join(await engine.store.root(s.id), "final/project/documents/paper.scholarpen.json"), "utf8")).toContain("prove causality");
});
test("external candidate edits block resume rather than overwrite", async () => {
  const { root, input } = await fixture(); const provider = fakeProvider({ failResponse: true }); const engine = new ReviewEngine(new SessionStore(root), provider); const s = await engine.create(input); await engine.start(s.id); await engine.wait(s.id);
  const sr = await engine.store.root(s.id); await writeFile(join(sr, "workspace/cycle-01/project/documents/paper.scholarpen.json"), "[]"); await engine.start(s.id); const done = await engine.wait(s.id); expect(done.status).toBe("failed"); expect(done.error).toContain("외부 변경");
});
test("path traversal, symlinks, and third cycle input are rejected", async () => {
  const { root, input } = await fixture(); await expect(scopedPath(root, "../escape")).rejects.toThrow(); await symlink("/tmp", join(root, "alias")); await expect(scopedPath(root, "alias/file")).rejects.toThrow("Symlink"); expect(() => parseInput({ ...input, maxCycles: 3 })).toThrow();
});
test("table numerical corrections require reproducible sources; protected citations survive", async () => {
  const { root } = await fixture(); const c = await context(root, ["paper.scholarpen.json"]); const target = c.slots.find(s => s.text === "35")!;
  const patch = { kind: "set-text" as const, id: "sum", slotId: target.id, before: "35", after: "30", commentIds: [comment.id], rationale: "Sum of explicit group counts" };
  expect(() => applyPatches(c, [patch], [comment], 1)).toThrow("수치 변경");
  const applied = applyPatches(c, [{ ...patch, calculation: { operation: "sum", sourceSlotIds: c.slots.filter(s => ["10", "20"].includes(s.text)).map(s => s.id), decimals: 0 } }], [comment], 1);
  expect(JSON.stringify(applied.documents)).toContain('"citekey":"smith2020"'); expect(applied.changes[0]!.after).toBe("30");
  expect(() => applyPatches(c, [{ ...patch, after: "31", calculation: { operation: "sum", sourceSlotIds: c.slots.filter(s => ["10", "20"].includes(s.text)).map(s => s.id), decimals: 0 } }], [comment], 1)).toThrow("calculation");
});
test("changed responses cannot cite non-applied changes; long human comments are lossless", async () => {
  expect(() => validateResponses([{ commentId: comment.id, disposition: "changed", response: "Done", changeIds: [], locations: [], verification: "not-assessed" }], [comment], [])).toThrow();
  const { root, input } = await fixture(); input.reviewers[0]!.original = "Question\n".repeat(800); const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id); expect(done.comments[0]!.original).toBe(input.reviewers[0]!.original);
});

test("exclusive writer lock rejects duplicate process access and recovers interrupted run status", async () => {
  const { root, input } = await fixture(); const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create(input);
  const release = await engine.store.lock(s.id); await expect(engine.store.lock(s.id)).rejects.toThrow("다른 실행"); await release();
  s.status = "running"; await engine.store.save(s); const recovered = await engine.recover(s.id); expect(recovered.status).toBe("paused"); expect(recovered.allocatedCycles).toBe(0);
});
test("cancellation ignores a late successful provider answer", async () => {
  const { root, input } = await fixture(); let respond!: (s: string) => void; let started!: () => void;
  const ready = new Promise<void>(r => { started = r; }); const pending = new Promise<string>(r => { respond = r; });
  const engine = new ReviewEngine(new SessionStore(root), { check: async () => ({ codex: "test", anthropic: "test" }), complete: async () => { started(); return pending; } });
  const s = await engine.create(input); await engine.start(s.id); await ready; const stopping = engine.stop(s.id, true);
  respond(JSON.stringify({ question: "late", claims: [], design: [], results: [], terms: [], argumentMap: "late", uncertainties: [] }));
  const cancelled = await stopping; expect(cancelled.status).toBe("cancelled"); expect(cancelled.completedCycles).toBe(0); expect(cancelled.comments).toHaveLength(0);
});
test("multiple documents with matching block IDs stay isolated", async () => {
  const { root, input } = await fixture(); await writeFile(join(root, "documents/supplement.scholarpen.json"), JSON.stringify(blocks)); input.documents.push("supplement.scholarpen.json");
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id); expect(done.status).toBe("completed");
  const sr = await engine.store.root(s.id); const supplement = await readFile(join(sr, "final/project/documents/supplement.scholarpen.json"), "utf8"); expect(supplement).toContain("prove causality");
});
test("unavailable figure formats cannot produce full-coverage quality", async () => {
  const { root, input } = await fixture(); const doc = [...structuredClone(blocks), { id: "svg", type: "figure", props: { sourcePath: "figures/chart.svg", caption: "Vector" }, content: [], children: [] }];
  await writeFile(join(root, "documents/paper.scholarpen.json"), JSON.stringify(doc)); await writeFile(join(root, "figures/chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id); expect(done.status).toBe("completed"); expect(done.quality).toBe("incomplete-coverage");
});
test("completed package pointer recovers after crash between round rename and session save", async () => {
  const { root, input } = await fixture(); const provider = fakeProvider(); const first = new ReviewEngine(new SessionStore(root), provider); const s = await first.create(input); await first.start(s.id); const done = await first.wait(s.id);
  done.status = "paused"; done.stage = "gpt-assessing(1)"; done.completedCycles = 0; done.rounds = []; done.selectedFinalRound = null; await first.store.save(done);
  const resumed = new ReviewEngine(new SessionStore(root), provider); const count = provider.calls.length; await resumed.start(s.id); const recovered = await resumed.wait(s.id); expect(recovered.status).toBe("completed"); expect(recovered.completedCycles).toBe(1); expect(provider.calls).toHaveLength(count);
});
test("cumulative changes remove reverted claims and replace superseded evidence", async () => {
  const { cumulativeChanges } = await import("./patches"); const a = { id: "C1-a", target: "p1", before: "A", after: "B", commentIds: ["R1-C01"], rationale: "reason" };
  expect(cumulativeChanges([a], [{ ...a, id: "C2-a", before: "B", after: "A" }])).toEqual([]);
  expect(cumulativeChanges([a], [{ ...a, id: "C2-a", before: "B", after: "C" }])).toEqual([{ ...a, id: "C2-a", after: "C" }]);
});
test("figure replacement requires matching approval and immutable input, exports are portable and private", async () => {
  const { realpath } = await import("node:fs/promises"); const fixtureResult = await fixture(1); const root = await realpath(fixtureResult.root); const input = { ...fixtureResult.input, projectPath: root };
  const { fileSystem } = await import("../fs/manager"); await fileSystem.openProjectByPath(root);
  const { decideFigure, importFigure, exportReview } = await import("./service");
  const provider = fakeProvider({ figureRequest: true, failResponse: true }); const engine = new ReviewEngine(new SessionStore(root), provider); const s = await engine.create(input); await engine.start(s.id); const pending = await engine.wait(s.id); const approval = pending.approvals[0]!;
  const address = { projectPath: root, sessionId: s.id, approvalId: approval.id };
  await expect(importFigure(address, join(root, "figures/plot-0.png"))).rejects.toThrow("승인");
  await decideFigure({ ...address, decision: "approved" }); await importFigure(address, join(root, "figures/plot-0.png")); await engine.start(s.id); const done = await engine.wait(s.id);
  expect(done.status).toBe("completed"); expect(done.rounds[0]!.changes.some(c => c.id.includes("figure"))).toBe(true); expect(done.rounds[0]!.authorChecks?.filter(c => c.kind === "figure")).toEqual([]);
  const exported = await exportReview({ ...address, editable: false }); expect(await Bun.file(join(exported, "response-to-reviewers.md")).exists()).toBe(true); expect(await Bun.file(join(exported, ".state/journal.jsonl")).exists()).toBe(false);
  const packaged = await context(join(exported, "project"), input.documents); expect(packaged.figures.every(f => f.available)).toBe(true);
  const sr = await engine.store.root(s.id); await expect(fileSystem.openProjectByPath(join(sr, "original/project"))).rejects.toThrow("Review storage");
  await expect(fileSystem.readTextFile(join(sr, "final/response-to-reviewers.md"))).rejects.toThrow("Review storage");
  await expect(decideFigure({ ...address, decision: "approved" })).rejects.toThrow("sealed");
});
test("numbered human requests preserve exact contiguous original ranges", async () => {
  const { importComments } = await import("./comment-import");
  const original = "Introductory note.\n\n1. Clarify methods.\nKeep this continuation.\n\n2) Explain limitations.\n";
  const comments = importComments({ id: "R2", name: "Reviewer 2", focus: "", original });
  expect(comments.map(c => c.original).join("")).toBe(original); expect(comments.map(c => c.id)).toEqual(["R2-C01", "R2-C02", "R2-C03"]);
  expect(comments.every(c => original.slice(c.sourceStart, c.sourceEnd) === c.original)).toBe(true);
});
test("explicit follow-up starts a new budget from the selected final candidate", async () => {
  const { root, input } = await fixture(); const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id); const child = await engine.followup(s.id);
  expect(child.input.parentSessionId).toBe(s.id); expect(child.allocatedCycles).toBe(0); expect(child.status).toBe("created"); expect(child.manifest.packageHash).toBe(done.rounds[0]!.packageHash);
});

test("unverified numerical proposal is deferred through resume and later rounds while safe changes complete", async () => {
  const { root, input } = await fixture(); input.language = "Korean";
  const document = JSON.parse(await readFile(join(root, "documents/paper.scholarpen.json"), "utf8"));
  document.push({ id: "p2", type: "paragraph", props: {}, content: [{ type: "text", text: "Volume increased 20% versus 7%.", styles: {} }], children: [] });
  await writeFile(join(root, "documents/paper.scholarpen.json"), JSON.stringify(document));
  const slot = (await context(root, input.documents)).slots.find(s => s.blockId === "p2")!;
  const base = fakeProvider({ alwaysRevise: true, failResponse: true });
  const provider = { ...base, async complete(r: ReviewModelRequest) {
    const value = await base.complete(r);
    if (r.stage !== "plan-1") return value;
    const plan = JSON.parse(value);
    plan.patches.push({ kind: "set-text", id: "P16", slotId: slot.id, before: slot.text, after: "1-second volume increased 20% versus 7%.", commentIds: ["R1-C01"], rationale: "Clarify measurement terminology" });
    return JSON.stringify(plan);
  }};
  const engine = new ReviewEngine(new SessionStore(root), provider);
  const s = await engine.create(input); await engine.start(s.id);
  expect((await engine.wait(s.id)).status).toBe("failed"); // simulated provider interruption, not the numerical guard
  const savedRoot = await engine.store.root(s.id);
  const receipt = JSON.parse(await readFile(join(savedRoot,"workspace/cycle-01/candidate.json"),"utf8"));
  expect(receipt.authorChecks).toHaveLength(1);
  await engine.start(s.id); const done = await engine.wait(s.id);
  expect(done.status).toBe("completed"); expect(done.completedCycles).toBe(2); expect(done.quality).toBe("needs-author-action");
  expect(done.rounds[1]!.authorChecks).toHaveLength(1);
  expect(done.rounds[1]!.responses[0]!.disposition).toBe("partially-addressed");
  const output = await readFile(join(savedRoot,"final/project/documents/paper.scholarpen.json"),"utf8");
  expect(output).toContain("indicate an association"); expect(output).toContain(slot.text); expect(output).not.toContain("1-second");
  const response = await readFile(join(savedRoot,"final/response-to-reviewers.md"),"utf8");
  expect(response).toContain("저자 확인 필요"); expect(response).toContain("보류한 제안 — 미적용"); expect(response).toContain("A1-P16");
  expect(JSON.parse(await readFile(join(savedRoot,"final/author-checks.json"),"utf8")).checks).toHaveLength(1);
});

test("baseline mismatch leaves that proposal unapplied while independent valid edits continue", async () => {
  const {root,input}=await fixture(); const c=await context(root,input.documents);
  const slot=c.slots.find(s=>s.blockId==='p1')!;
  const patch={kind:'set-text' as const,id:'P18',slotId:slot.id,before:'Incorrect baseline',after:'Proposed wording',commentIds:[comment.id],rationale:'Clarify'};
  const result=applyPatches(c,[patch],[comment],1,{deferUnverified:true});
  expect(result.changes).toHaveLength(0);expect(result.authorChecks[0]!.before).toBe(slot.text);
  expect(result.documents).toEqual(c.documents);
});

test("live model output is visible during a call and cleared after completion", async () => {
  const {root,input}=await fixture(); const base=fakeProvider();
  let request: ReviewModelRequest | undefined; let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r});
  const engine=new ReviewEngine(new SessionStore(root),{...base,async complete(r){if(r.stage==='manuscript-contract'){request=r;await gate;}return base.complete(r)}});
  const s=await engine.create(input);await engine.start(s.id);
  try {
    for(let i=0;i<100&&!request;i++)await new Promise(r=>setTimeout(r,10));
    expect(request).toBeDefined();request!.onOutput?.(240);
    const {readReviewProgress}=await import('./progress');
    const progress=await readReviewProgress(await engine.store.root(s.id),await engine.store.load(s.id),engine.liveOutput(s.id));
    expect(progress.activeCall?.receivedCharacters).toBe(240);expect(progress.activeCall?.lastOutputAt).toBeDefined();
  } finally {release();await engine.wait(s.id)}
  expect(engine.liveOutput(s.id)).toBeUndefined();
});

for (const stage of ["manuscript-contract", "baseline-figures-1", "initial-R1", "responses-1", "round-1-figures-1", "assessment-1"]) {
  test(`unusable ${stage} output records a limitation and still produces reference materials`, async () => {
    const {root,input}=await fixture(1); input.maxCycles=1;
    if(stage.startsWith("initial")) input.mode="virtual";
    const provider=fakeProvider();const complete=provider.complete;
    let attempts=0; provider.complete=async r=>{ if(r.stage===stage){attempts++;return "{invalid";} return complete(r); };
    const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
    expect(done.status).toBe("completed");expect(attempts).toBe(3);expect(done.quality).not.toBe("ready-for-author-review");
    expect(done.warnings!.some(w=>w.stage===stage)).toBe(true);
    const sr=await engine.store.root(s.id);
    expect(await readFile(join(sr,"final/response-to-reviewers.md"),"utf8")).toContain("Automated review limitations");
    expect(await readFile(join(sr,"final/review-warnings.json"),"utf8")).toContain(stage);
  });
}
test("incomplete/conflicting plan entries and unknown figure targets do not block valid edits",async()=>{
  const {root,input}=await fixture(1);const provider=fakeProvider();const complete=provider.complete;
  provider.complete=async r=>{const data=JSON.parse(await complete(r));if(r.stage==="plan-1"){
    data.decisions=[];data.patches.push({...data.patches[0],id:"bad-link",commentIds:["unknown"]});
    data.figures=[{figureId:"unknown",commentIds:["R1-C01"],specification:"Replace"},...Array.from({length:2},()=>({figureId:"paper.scholarpen.json#f0",commentIds:["R1-C01"],specification:"Duplicate"}))];
  }return JSON.stringify(data);};
  const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
  expect(done.status).toBe("completed");expect(done.rounds[0]!.changes).toHaveLength(1);expect(done.rounds[0]!.authorChecks!.length).toBeGreaterThanOrEqual(4);expect(done.approvals).toHaveLength(0);
});
for(const defect of ["missing", "duplicate", "unknown", "empty", "unapplied", "no-evidence", "no-location", "blank-location", "figure-wait"]){
  test(`response defect ${defect} becomes an author check instead of stopping`,async()=>{
    const {root,input}=await fixture();const provider=fakeProvider();const complete=provider.complete;
    provider.complete=async r=>{const data=JSON.parse(await complete(r));if(r.stage==="responses-1"){
      const response=data.responses[0];
      if(defect==="missing") data.responses=[];
      if(defect==="duplicate") data.responses.push({...response});
      if(defect==="unknown") response.commentId="unknown";
      if(defect==="empty") response.response=" ";
      if(defect==="unapplied") response.changeIds=["invented-change"];
      if(defect==="no-evidence") response.changeIds=[];
      if(defect==="no-location"||defect==="blank-location"){response.disposition="clarified-no-change";response.locations=defect==="no-location"?[]:[" "];}
      if(defect==="figure-wait") response.disposition="awaiting-figure-approval";
    }return JSON.stringify(data);};
    const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
    expect(done.status).toBe("completed");const result=done.rounds[0]!;expect(result.responses).toHaveLength(1);expect(result.responses[0]!.disposition).toBe("partially-addressed");
    expect(result.responses[0]!.verification).toBe("not-verified");expect(result.responses[0]!.response).toContain("Unverified draft");
    expect(result.authorChecks!.some(c=>c.kind==="response")).toBe(true);expect(done.quality).toBe("needs-author-action");
  });
}
test("missing, duplicate and unknown assessment entries remain unverified without stopping",async()=>{
  const {root,input}=await fixture();const provider=fakeProvider();const complete=provider.complete;
  provider.complete=async r=>{const data=JSON.parse(await complete(r));if(r.stage==="assessment-1") data.comments=[{commentId:"unknown",verification:"verified",reason:"Invented"}];return JSON.stringify(data);};
  const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
  expect(done.status).toBe("completed");expect(done.quality).toBe("needs-author-action");expect(done.rounds[0]!.responses[0]!.verification).toBe("not-verified");
});
test("legacy cached no-change response resumes without model retry or another cycle",async()=>{
  const {root,input}=await fixture();input.language="한국어";const provider=fakeProvider();const complete=provider.complete;let fail=true;let responseCalls=0;
  provider.complete=async r=>{if(r.stage==="assessment-1"&&fail){fail=false;throw Error("Temporary test interruption");}
    const data=JSON.parse(await complete(r));if(r.stage==="responses-1"){responseCalls++;data.responses[0].disposition="clarified-no-change";data.responses[0].locations=[];}return JSON.stringify(data);};
  const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);await engine.wait(s.id);
  const sr=await engine.store.root(s.id);const path=join(sr,"workspace/cycle-01/candidate.json");const receipt=JSON.parse(await readFile(path,"utf8"));receipt.authorChecks=[];await writeFile(path,JSON.stringify(receipt));
  const resumed=new ReviewEngine(new SessionStore(root),provider);await resumed.start(s.id);const done=await resumed.wait(s.id);
  expect(done.status).toBe("completed");expect(done.allocatedCycles).toBe(1);expect(responseCalls).toBe(1);
  expect(await readFile(join(sr,"final/response-to-reviewers.md"),"utf8")).toContain("검증되지 않은 초안");
});
test("oversized full input generates an explicitly unassessed package without truncating or calling providers",async()=>{
  const {root,input}=await fixture();input.maxCycles=1;
  const large=structuredClone(blocks);large[0]!.content=[{type:"text",text:"full manuscript ".repeat(50000),styles:{}}] as any;
  await writeFile(join(root,"documents/paper.scholarpen.json"),JSON.stringify(large));
  const provider=fakeProvider();const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
  expect(done.status).toBe("completed");expect(provider.calls).toHaveLength(0);expect(done.quality).toBe("needs-author-action");
  expect(await readFile(join(await engine.store.root(s.id),"final/project/documents/paper.scholarpen.json"),"utf8")).toContain("full manuscript ".repeat(50000));
});
test("readable manuscript with irregular structure remains read-only reference while the run completes",async()=>{
  const {root,input}=await fixture();const malformed=structuredClone(blocks);malformed[1]!.content={type:"tableContent",rows:[{cells:[]}]} as any;
  await writeFile(join(root,"documents/paper.scholarpen.json"),JSON.stringify(malformed));
  const engine=new ReviewEngine(new SessionStore(root),fakeProvider());const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
  expect(done.status).toBe("completed");expect(done.quality).toBe("incomplete-coverage");expect(done.rounds[0]!.changes).toHaveLength(0);
  expect(JSON.parse(await readFile(join(await engine.store.root(s.id),"final/project/documents/paper.scholarpen.json"),"utf8"))).toEqual(malformed);
});
for(const failure of ["missing","changed"]){
  test(`unusable imported replacement (${failure}) retains the original and continues`,async()=>{
    const {root,input}=await fixture(1);const provider=fakeProvider({figureRequest:true,failResponse:true});
    const engine=new ReviewEngine(new SessionStore(root),provider);const s=await engine.create(input);await engine.start(s.id);const stopped=await engine.wait(s.id);
    const sr=await engine.store.root(s.id);const approval=stopped.approvals[0]!;
    approval.status="imported";approval.outputPath="approvals/replacement.png";approval.outputHash=hash("expected");
    if(failure==="changed") { await mkdir(join(sr,"approvals"),{recursive:true}); await writeFile(join(sr,approval.outputPath),"modified"); }
    await engine.store.save(stopped);await engine.start(s.id);const done=await engine.wait(s.id);
    expect(done.status).toBe("completed");expect(done.approvals[0]!.status).toBe("deferred");
    expect(done.rounds[0]!.authorChecks!.some(c=>c.kind==="figure")).toBe(true);
    expect(await readFile(join(sr,"final/project/figures/plot-0.png"))).toEqual(await readFile(join(root,"figures/plot-0.png")));
  });
}
test("exhausted format repairs stay bounded when resuming a later provider failure",async()=>{
  const {root,input}=await fixture();const provider=fakeProvider({invalidJSON:true,failResponse:true});const engine=new ReviewEngine(new SessionStore(root),provider);
  const s=await engine.create(input);await engine.start(s.id);expect((await engine.wait(s.id)).status).toBe("failed");
  const resumed=new ReviewEngine(new SessionStore(root),provider);await resumed.start(s.id);const done=await resumed.wait(s.id);
  expect(done.status).toBe("completed");expect(provider.calls.filter(c=>c.stage==="plan-1")).toHaveLength(3);
});

test('editable revision stays inside the project, saves independently and reopens without overwriting user edits', async()=>{
  const f=await fixture(1); const root=await realpath(f.root); const input={...f.input,projectPath:root};
  const {fileSystem}=await import('../fs/manager'); await fileSystem.openProjectByPath(root);
  const engine=new ReviewEngine(new SessionStore(root),fakeProvider());const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
  const copy=join(root,'revisions',s.id);expect(done.editablePath).toBe(copy);
  const filename=input.documents[0]!;const source=await readFile(join(root,'documents',filename),'utf8');
  expect(await readFile(join(copy,'documents',filename),'utf8')).toContain('indicate an association');
  const edited=await fileSystem.loadDocument(copy,filename) as any[];edited[0].content[0].text='The author revised this interpretation.';
  await fileSystem.saveDocument(copy,filename,edited);
  expect(await fileSystem.collabStatePath(copy,filename)).toStartWith(join(copy,'.scholarpen/collab'));
  expect(await readFile(join(root,'documents',filename),'utf8')).toBe(source);
  const {exportReview,reviewRevisionContext}=await import('./service');
  const reopened=await exportReview({projectPath:root,sessionId:s.id,editable:true});expect(reopened).toBe(copy);
  expect(await readFile(join(copy,'documents',filename),'utf8')).toContain('The author revised');
  const panel=await reviewRevisionContext({projectPath:copy,filename});
  expect(panel!.changes[0]!.before).toContain('prove causality');expect(panel!.changes[0]!.after).toContain('indicate an association');
  expect(JSON.stringify(panel!.original)).toContain('prove causality');expect(panel!.comments[0]!.comment.original).toBe(comment.original);
  expect(panel!.comments[0]!.response!.response).toContain('clarified');
  const tree=await fileSystem.listProjectFiles(root);expect(tree.some(n=>n.name==='revisions')).toBe(true);
  const {collectDocumentNodes}=await import('../../renderer/utils/document-tree');
  expect(collectDocumentNodes(tree).some(n=>n.path===join(copy,'documents',filename))).toBe(true);
  expect(await fileSystem.readFigure(copy,'figures/plot-0.png')).toStartWith('data:image/png;base64,');
  expect(await fileSystem.loadBibtex(copy)).toContain('smith2020');
});

test('chapter sidebar selects its comments and keeps unlocated comments without leaking other chapters', async()=>{
  const {chapterContext}=await import('../../shared/review-session/chapter-context');
  const {root,input}=await fixture();const engine=new ReviewEngine(new SessionStore(root),fakeProvider());const s=await engine.create(input);await engine.start(s.id);const done=await engine.wait(s.id);
  done.input.documents.push('other.scholarpen.json');
  done.comments.push({...comment,id:'R2-C01',original:'Other chapter only',targets:['other.scholarpen.json#p1']},{...comment,id:'R3-C01',original:'General concern',targets:[]});
  const panel=chapterContext(done,done.rounds[0]!,input.documents[0]!,root);
  expect(panel.comments.map(c=>c.comment.id)).toEqual(['R1-C01','R3-C01']);
  expect(panel.comments.find(c=>c.comment.id==='R3-C01')!.scope).toBe('unlocated');
});

test('editing chapter responses updates working JSON and Markdown, preserves originals, and rejects stale writes', async () => {
  const f = await fixture(); const root = await realpath(f.root); const input = { ...f.input, projectPath: root };
  const { fileSystem } = await import('../fs/manager'); await fileSystem.openProjectByPath(root);
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  const copy = done.editablePath!; const sealedRoot = join(await engine.store.root(s.id), 'final'); const before = await manifest(sealedRoot);
  const { reviewRevisionContext, reviewSaveRevisionResponse } = await import('./service');
  const filename = input.documents[0]!; const initial = (await reviewRevisionContext({ projectPath: copy, filename }))!;
  const ai = initial.comments[0]!.response!.response;
  const request = { projectPath: copy, filename, commentId: 'R1-C01', response: 'We have revised our response after checking the manuscript.\n한글 답변도 저장합니다.', expectedResponse: ai };
  expect(await reviewSaveRevisionResponse(request)).toBe(request.response);
  const reopened = (await reviewRevisionContext({ projectPath: copy, filename }))!;
  expect(reopened.editableResponses![0]!.response).toBe(request.response);
  expect(reopened.editableResponses![0]!.verification).toBe('not-verified');
  expect(reopened.comments[0]!.response!.response).toBe(ai);
  expect(await readFile(join(copy, 'response-to-reviewers.md'), 'utf8')).toContain(request.response);
  expect(await manifest(sealedRoot)).toEqual(before);
  await expect(reviewSaveRevisionResponse({ ...request, response: 'stale overwrite' })).rejects.toThrow('다른 곳');
  await writeFile(join(copy, 'response-to-reviewers.md'), 'Author-edited full letter');
  expect(await reviewSaveRevisionResponse(request)).toBe(request.response); // Idempotent retry repairs Markdown too.
  expect(await readFile(join(copy, '.scholarpen/response-backups', hash('Author-edited full letter') + '.md'), 'utf8')).toBe('Author-edited full letter');
  await expect(reviewSaveRevisionResponse({ ...request, filename: '../paper.scholarpen.json' })).rejects.toThrow();
  await expect(reviewSaveRevisionResponse({ ...request, projectPath: root })).rejects.toThrow();
  expect(await readFile(join(root, 'documents', filename), 'utf8')).toContain('prove causality');
});

test('concurrent response saves merge different comments and share one response across chapters', async () => {
  const { root, input } = await fixture(); const engine = new ReviewEngine(new SessionStore(root), fakeProvider());
  const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  const result = done.rounds[0]!; done.input.documents.push('other.scholarpen.json');
  done.comments[0]!.targets.push('other.scholarpen.json');
  done.comments.push({ ...comment, id: 'R2-C01', targets: ['other.scholarpen.json'] });
  result.responses.push({ ...result.responses[0]!, commentId: 'R2-C01', response: 'Second answer', locations: ['other.scholarpen.json'] });
  await writeJSON(done.editablePath!, 'response.json', { schemaVersion: 1, responses: result.responses });
  const { saveRevisionResponse, readEditableResponses } = await import('./revision-responses');
  await Promise.all([
    saveRevisionResponse(done.editablePath!, done, result, { projectPath: done.editablePath!, filename: input.documents[0]!, commentId: 'R1-C01', expectedResponse: result.responses[0]!.response, response: 'Shared answer' }),
    saveRevisionResponse(done.editablePath!, done, result, { projectPath: done.editablePath!, filename: 'other.scholarpen.json', commentId: 'R2-C01', expectedResponse: 'Second answer', response: 'Other chapter answer' }),
  ]);
  const responses = await readEditableResponses(done.editablePath!, result);
  expect(responses.map(r => r.response)).toEqual(['Shared answer', 'Other chapter answer']);
  await saveRevisionResponse(done.editablePath!, done, result, { projectPath: done.editablePath!, filename: 'other.scholarpen.json', commentId: 'R1-C01', expectedResponse: 'Shared answer', response: 'Shared answer from the other chapter' });
  const md = await readFile(join(done.editablePath!, 'response-to-reviewers.md'), 'utf8');
  expect(md).toContain('Shared answer from the other chapter'); expect(md).toContain('Other chapter answer');
  await expect(saveRevisionResponse(done.editablePath!, done, result, { projectPath: done.editablePath!, filename: input.documents[0]!, commentId: 'R2-C01', expectedResponse: 'Other chapter answer', response: 'Wrong chapter' })).rejects.toThrow('현재 장');
});

test('Review and full-letter/share exports use every latest author answer and saved revision manuscript', async () => {
  const f = await fixture(1); const root = await realpath(f.root); const input = { ...f.input, projectPath: root };
  const { fileSystem } = await import('../fs/manager'); await fileSystem.openProjectByPath(root);
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create(input); await engine.start(s.id); const done = await engine.wait(s.id);
  const result = done.rounds[0]!; const copy = done.editablePath!;
  // A general comment must be included, even without a chapter location.
  done.comments.push({ ...comment, id: 'R2-C01', reviewerId: 'R2', original: 'General concern\n<script>alert(1)</script>', targets: [] });
  result.responses.push({ ...result.responses[0]!, commentId: 'R2-C01', response: 'General AI answer', locations: [] });
  await engine.store.save(done); await writeJSON(copy, 'response.json', { responses: result.responses });
  const sealedRoot = join(await engine.store.root(s.id), 'final'); const sealed = await manifest(sealedRoot);
  const { reviewSaveRevisionResponse, reviewView, exportReviewResponses, exportReview } = await import('./service');
  const answers = ['Author final answer.\n수정된 답변입니다.', 'General author answer <img src=x onerror=alert(2)>'];
  for (const [i, response] of result.responses.entries()) await reviewSaveRevisionResponse({ projectPath: copy, filename: input.documents[0]!, commentId: response.commentId, expectedResponse: response.response, response: answers[i]! });
  await writeJSON(copy, `documents/${input.documents[0]}`, [{ ...blocks[0], content: [{ type: 'text', text: 'Author final manuscript', styles: {} }] }]);
  const address = { projectPath: root, sessionId: s.id };
  const view = await reviewView(address);
  expect(view.responseDocument?.source).toBe('revision'); expect(view.responseDocument?.editedCommentIds).toEqual(['R1-C01', 'R2-C01']);
  expect(view.responseDocument?.responses.map(r => r.response)).toEqual(answers);
  expect(view.session.rounds[0]!.responses[0]!.response).toBe(result.responses[0]!.response);
  for (const output of [await exportReviewResponses(address), await exportReview({ ...address, editable: false })]) {
    expect(output.startsWith(join(root, 'exports') + '/')).toBe(true);
    const md = await readFile(join(output, 'response-to-reviewers.md'), 'utf8');
    expect(md).toBe(view.responsesMarkdown);
    for (const answer of answers) expect(md).toContain(answer);
    for (const c of done.comments) expect(md).toContain(c.id);
    expect(md).not.toContain(result.responses[0]!.response); expect(md).not.toContain('General AI answer');
    const html = await readFile(join(output, 'response-to-reviewers.html'), 'utf8');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).toContain('@media print');
    if (output.includes('-share-')) {
      expect(await readFile(join(output, 'project/documents', input.documents[0]!), 'utf8')).toContain('Author final manuscript');
      expect(JSON.parse(await readFile(join(output, 'package-manifest.json'), 'utf8')).quality).toBe('author-edited-not-revalidated');
    }
  }
  expect(await manifest(sealedRoot)).toEqual(sealed);
  expect(await readFile(join(root, 'documents', input.documents[0]!), 'utf8')).toContain('prove causality');
});

test('corrupt or missing working answers never fall back to the old AI letter', async () => {
  const f = await fixture(); const root = await realpath(f.root);
  const { fileSystem } = await import('../fs/manager'); await fileSystem.openProjectByPath(root);
  const engine = new ReviewEngine(new SessionStore(root), fakeProvider()); const s = await engine.create({ ...f.input, projectPath: root }); await engine.start(s.id); const done = await engine.wait(s.id);
  const { reviewView, exportReviewResponses } = await import('./service'); const address = { projectPath: root, sessionId: s.id };
  await writeJSON(done.editablePath!, 'response.json', { responses: [] });
  const view = await reviewView(address); expect(view.responsesMarkdown).toBe(''); expect(view.responseError).toContain('형식');
  await expect(exportReviewResponses(address)).rejects.toThrow('형식');
  await rm(done.editablePath!, { recursive: true });
  expect((await reviewView(address)).responseError).toContain('찾을 수 없습니다');
  await expect(exportReviewResponses(address)).rejects.toThrow('찾을 수 없습니다');
});
