import { ensureEditableRevision } from "./editable-copy";
import { reconcilePlan, reconcileResponses, reconcileAssessment } from "./reconcile";
import { mergeAuthorChecks, includeAuthorChecks } from "./author-checks";
import { importComments } from "./comment-import";
import { mkdir, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentImage } from "../../shared/rpc-types";
import type { ReviewSession, ReviewInput, ReviewComment, ReviewContext, RevisionPlan, RoundResult, AppliedChange, AuthorCheck } from "../../shared/review-session/types";
import { parseInput, parsePlan, parseResponses, parseAssessment, parseModelJSON, object, array, string, strings, oneOf } from "../../shared/review-session/schema";
import { SessionStore } from "./session-store";
import { hash, writeJSON, readJSON, copyPackage, exists, scopedPath, atomicWrite, manifest } from "./workspace";
import { context, contextText, figureImage, setPath, atPath } from "./context";
import { applyPatches, savePatchedDocuments, validateCommentIds, validateResponses, cumulativeChanges } from "./patches";
import { finalize } from "./export";
import { SYSTEM, PLAN_SCHEMA, RESPONSE_SCHEMA, ASSESS_SCHEMA, REVIEW_PROMPT_VERSION } from "./prompts";
import { REVIEW_CALL_TIMEOUT_MS, type LiveReviewOutput } from "./progress";
export interface ReviewModelRequest { provider: "codex" | "anthropic"; model: string; stage: string; language?: string; system: string; prompt: string; images: AgentImage[]; signal: AbortSignal; onOutput?: (characters: number) => void }
export interface ReviewProviders {
  check(input: ReviewInput): Promise<{ codex: string; anthropic: string }>;
  complete(request: ReviewModelRequest): Promise<string>;
}
export class ReviewEngine {
  private output = new Map<string, LiveReviewOutput>();
  liveOutput(id: string) { return this.output.get(id); }
  private active = new Map<string, { controller: AbortController; promise: Promise<void>; stop: "paused" | "cancelled" | null }>();
  constructor(readonly store: SessionStore, readonly providers: ReviewProviders) {}
  async create(value: unknown) { const input = parseInput(value); if (input.projectPath !== this.store.project) throw new Error("Project scope mismatch"); return this.store.create(input); }
  async followup(id: string) {
    const parent = await this.store.load(id);
    if (parent.status !== "completed" || !parent.selectedFinalRound) throw new Error("완료된 최종 후보에서만 후속 세션을 만들 수 있습니다.");
    const root = await this.store.root(id); const baseline = join(root, "final/project");
    const result = parent.rounds.find(r => r.round === parent.selectedFinalRound)!;
    if ((await manifest(baseline)).packageHash !== result.packageHash) throw new Error("Parent candidate integrity mismatch");
    return this.store.create({ ...parent.input, parentSessionId: id, baselineNote: `Follow-up to ${id}, round ${parent.selectedFinalRound}. Previous internal issues: ${result.assessment.issues.join("; ")}` }, baseline);
  }
  async start(id: string) {
    if (this.active.has(id)) return this.store.load(id);
    const release = await this.store.lock(id);
    let s: ReviewSession;
    try {
      s = await this.store.load(id);
      if (["completed", "cancelled"].includes(s.status)) throw new Error("종료된 세션은 다시 실행할 수 없습니다. 후속 세션을 시작해 주세요.");
      s.status = "running"; s.error = null; s.runId = randomUUID(); await this.store.save(s);
      await this.store.event(id, { kind: "run-start", stage: s.stage, runId: s.runId });
    } catch (e) { await release(); throw e; }
    const controller = new AbortController();
    const job = { controller, promise: Promise.resolve(), stop: null as "paused" | "cancelled" | null };
    this.active.set(id, job);
    job.promise = this.run(s, controller.signal).catch(async error => {
      s.status = job.stop ?? "failed";
      s.error = error instanceof Error ? error.message : String(error);
      await this.store.event(id, { kind: "stopped", stage: s.stage, status: s.status, error: s.error });
      await this.store.save(s);
    }).finally(async () => { try { await release(); } finally { this.active.delete(id); this.output.delete(id); } });
    return s;
  }
  async recover(id: string) {
    const s = await this.store.load(id);
    if (s.status !== "running" || this.active.has(id)) return s;
    let release: (() => Promise<void>) | undefined;
    try { release = await this.store.lock(id); } catch { return s; }
    try {
      s.status = "paused"; s.error = "이전 실행이 중단되었습니다. 완료된 단계는 재사용하며 불확실한 외부 호출은 재시도될 수 있습니다."; await this.store.save(s); return s;
    } finally { await release(); }
  }
  async wait(id: string) { await this.active.get(id)?.promise; return this.store.load(id); }
  async stop(id: string, cancel: boolean) {
    const job = this.active.get(id);
    if (job) { job.stop = cancel ? "cancelled" : "paused"; job.controller.abort(new Error(cancel ? "사용자가 취소했습니다." : "사용자가 일시정지했습니다.")); await job.promise; }
    else { const release = await this.store.lock(id); try { const s = await this.store.load(id); if (s.status !== "completed" && s.status !== "cancelled") { s.status = cancel ? "cancelled" : "paused"; await this.store.save(s); } } finally { await release(); } }
    return this.store.load(id);
  }
  private async stage(s: ReviewSession, stage: string, signal: AbortSignal) { signal.throwIfAborted(); s.stage = stage; await this.store.save(s); await this.store.event(s.id, { kind: "stage-start", stage }); }
  private async degraded<T>(s: ReviewSession, stage: string, reason: string, fallback?: () => T): Promise<T> {
    if (!fallback) throw new Error(reason);
    s.warnings ??= [];
    if (!s.warnings.some(w => w.stage === stage && w.reason === reason)) s.warnings.push({ stage, reason });
    await this.store.save(s);
    await this.store.event(s.id, { kind: "review-warning", stage, reason });
    return fallback();
  }
  private async call<T>(s: ReviewSession, role: "reviewer" | "reviser", stage: string, prompt: string, parse: (v: unknown) => T, signal: AbortSignal, images: AgentImage[] = [], fallback?: () => T): Promise<T> {
    signal.throwIfAborted();
    if (prompt.length > 700_000) return this.degraded(s, stage, "Full input exceeds the model request budget. This stage was not assessed; input was not silently truncated.", fallback);
    const root = await this.store.root(s.id); const config = s.roles[role];
    const inputHash = hash(JSON.stringify({ config, prompt, images, version: REVIEW_PROMPT_VERSION })); const key = `.state/calls/${inputHash}`;
    if (await exists(root, `${key}.json`)) { const value = parse(await readJSON(root, `${key}.json`)); await this.store.event(s.id, { kind: "cache-used", stage }); return value; }
    const attempts = await exists(root, `${key}.attempts.json`) ? await readJSON<number>(root, `${key}.attempts.json`) : 0;
    for (let attempt = attempts + 1; attempt <= 3; attempt++) {
      signal.throwIfAborted(); await writeJSON(root, `${key}.attempts.json`, attempt);
      await this.store.event(s.id, { kind: "model-start", stage, attempt, inputHash, provider: config.provider, model: config.model, cliVersion: s.providerVersions[config.provider], promptVersion: REVIEW_PROMPT_VERSION });
      // Keep complete input provenance but never persist account settings or tokens.
      await writeJSON(root, `${key}.input.json`, { stage, inputHash, prompt, images: images.map(i => ({ name: i.name, hash: hash(i.dataUrl) })), config, promptVersion: REVIEW_PROMPT_VERSION });
      let requestPrompt = prompt;
      if (attempt > 1 && await exists(root, `${key}.attempt-${attempt - 1}.txt`)) {
        const prior = await readFile(await scopedPath(root, `${key}.attempt-${attempt - 1}.txt`), "utf8");
        const error = await exists(root, `${key}.error.txt`) ? await readFile(await scopedPath(root, `${key}.error.txt`), "utf8") : "Invalid schema";
        requestPrompt += `\n\nTECHNICAL FORMAT REPAIR ONLY. Do not create new substantive changes, facts, decisions or reasoning. Preserve the previous answer's meaning and patch values. Convert only its JSON representation to the exact requested schema (string fields must be strings). Validation error: ${error}\nPrevious output: ${prior}`;
      }
      await writeJSON(root, `${key}.attempt-${attempt}.input.json`, { prompt: requestPrompt, hash: hash(requestPrompt) });
      let output: string;
      const activity: LiveReviewOutput = { stage, startedAt: new Date().toISOString(), receivedCharacters: 0 };
      this.output.set(s.id, activity);
      try {
        output = await this.providers.complete({ ...config, stage, language: s.input.language, system: SYSTEM, prompt: requestPrompt, images,
          signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_CALL_TIMEOUT_MS)]),
          onOutput: characters => { if (!signal.aborted && this.output.get(s.id) === activity) { activity.receivedCharacters = characters; activity.lastOutputAt = new Date().toISOString(); } },
        });
        signal.throwIfAborted();
      } catch (e) { await this.store.event(s.id, { kind: "model-error", stage, attempt, inputHash }); throw e; }
      finally { this.output.delete(s.id); }
      await atomicWrite(root, `${key}.attempt-${attempt}.txt`, output);
      let json: unknown; let value: T;
      try { json = parseModelJSON(output); value = parse(json); }
      catch (e) {
        signal.throwIfAborted(); await atomicWrite(root, `${key}.error.txt`, String(e));
        await this.store.event(s.id, { kind: "schema-error", stage, attempt, inputHash, error: String(e) });
        if (attempt === 3) return this.degraded(s, stage, "AI output remained unusable after two format repairs. This stage requires author review; raw outputs are retained in the session.", fallback);
        continue;
      }
      signal.throwIfAborted(); await writeJSON(root, `${key}.json`, json);
      await this.store.event(s.id, { kind: "model-complete", stage, attempt, inputHash, outputHash: hash(output), returnedModel: "not exposed by subscription adapter" }); return value;
    }
    return this.degraded(s, stage, "The saved model format-repair budget is exhausted. This stage requires author review.", fallback);
  }
  private async visualReview(s: ReviewSession, c: ReviewContext, project: string, stage: string, signal: AbortSignal) {
    const findings: unknown[] = []; const available = c.figures.filter(f => f.available);
    for (let i = 0; i < available.length; i += 4) {
      const batch = available.slice(i, i + 4); const images = await Promise.all(batch.map(f => figureImage(project, f)));
      const result = await this.call(s, "reviewer", `${stage}-figures-${i / 4 + 1}`, `Review the actual attached figure pixels together with their captions and manuscript. Do not infer precise raw data from pixels. Report missing labels, uncertainty and consistency. Return {findings:[{figureId,assessment,limitations}]}, exactly one per attached figure.\n${contextText(c)}\nAttached figure IDs: ${JSON.stringify(batch.map(f => f.id))}`, v => {
        const items = array(object(v).findings).map(v => { const x = object(v); return { figureId: string(x.figureId), assessment: string(x.assessment), limitations: string(x.limitations) }; });
        if (items.length !== batch.length || new Set(items.map(x => x.figureId)).size !== batch.length || items.some(x => !batch.some(f => f.id === x.figureId))) throw new Error("Incomplete figure assessment"); return items;
      }, signal, images, () => batch.map(f => ({ figureId: f.id, assessment: "Not assessed", limitations: "Automated figure review could not be completed. Author review required." })));
      findings.push(...result);
      c.coverage.push(...batch.map(f => ({ target: f.id, hash: f.hash, status: s.warnings?.some(w => w.stage === `${stage}-figures-${i / 4 + 1}`) ? "unavailable" as const : "read" as const, detail: s.warnings?.some(w => w.stage === `${stage}-figures-${i / 4 + 1}`) ? `${stage}: automated figure assessment unavailable; author review required` : `${stage}: actual pixels + caption + complete manuscript; batch ${i / 4 + 1}` })));
    }
    return findings;
  }
  private async initial(s: ReviewSession, c: ReviewContext, root: string, signal: AbortSignal) {
    if (s.comments.length) return;
    await this.stage(s, "context-building", signal);
    const contract = await this.call(s, "reviewer", "manuscript-contract", `Extract a conservative source-located manuscript contract. Return {question:string,claims:string[],design:string[],results:string[],terms:string[],argumentMap:string,uncertainties:string[]}. question and argumentMap MUST be plain strings, never objects or arrays. Do not certify inferred facts. Author constraints: ${JSON.stringify(s.input.authorConstraints)}\n${contextText(c)}`, v => {
      const x = object(v); return { question: string(x.question), claims: strings(x.claims), design: strings(x.design), results: strings(x.results), terms: strings(x.terms), argumentMap: string(x.argumentMap), uncertainties: strings(x.uncertainties) };
    }, signal, [], () => ({ question: "Not assessed", claims: [], design: [], results: [], terms: [], argumentMap: "Not assessed", uncertainties: ["Automated manuscript contract could not be generated. Verify against the full manuscript."] }));
    await writeJSON(root, "context/manuscript-contract.json", { schemaVersion: 1, ...contract });
    const figures = await this.visualReview(s, c, join(root, "original/project"), "baseline", signal);
    await writeJSON(root, "context/figure-review.json", figures);
    await writeJSON(root, "context/coverage.json", c.coverage);
    await this.stage(s, s.input.mode === "peer" ? "importing-comments" : "initial-reviewing", signal);
    const comments: ReviewComment[] = [];
    if (s.input.decisionLetter.trim()) comments.push({ id: "ED-C01", reviewerId: "ED", original: s.input.decisionLetter, targets: [], severity: "major", source: "human" });
    for (const reviewer of s.input.reviewers) {
      if (s.input.mode === "peer") {
        // Explicit numbering can be split without inventing meaning or losing source ranges.
        comments.push(...importComments(reviewer));
      } else {
        const result = await this.call(s, "reviewer", `initial-${reviewer.id}`, `Independently review this manuscript from this perspective: ${JSON.stringify(reviewer.focus)}. Other reviewer opinions are deliberately absent. Return {comments:[{original,targets:string[],severity:"major"|"minor"}]}. Targets are exact manuscript locations.\nContract: ${JSON.stringify(contract)}\nFigure findings: ${JSON.stringify(figures)}\n${contextText(c)}`, v => array(object(v).comments).map(v => { const x = object(v); return { original: string(x.original), targets: strings(x.targets), severity: oneOf(x.severity, ["major", "minor"]) }; }), signal, [], () => [{ original: "Automated review from this perspective could not be completed. Author review is required.", targets: [], severity: "major" as const }]);
        comments.push(...result.map((x, i) => ({ ...x, id: `${reviewer.id}-C${String(i + 1).padStart(2, "0")}`, reviewerId: reviewer.id, source: "virtual" as const })));
      }
    }
    if (!comments.length) comments.push({ id: "R1-C01", reviewerId: "R1", original: "No initial concerns identified; verify consistency without unnecessary changes.", targets: [], severity: "minor", source: "virtual" });
    s.comments = comments; await writeJSON(root, "inputs/normalized-comments.json", { schemaVersion: 1, comments }); await this.store.save(s);
  }
  private async run(s: ReviewSession, signal: AbortSignal) {
    const root = await this.store.root(s.id); await this.stage(s, "preflight", signal);
    s.providerVersions = await this.providers.check(s.input); signal.throwIfAborted(); await this.store.save(s);
    if ((await manifest(join(root, "original/project"))).packageHash !== s.manifest.packageHash) throw new Error("원본 스냅샷 무결성 검사 실패");
    const original = await context(join(root, "original/project"), s.input.documents); contextText(original);
    await this.initial(s, original, root, signal);
    while (s.completedCycles < s.input.maxCycles) {
      if (s.allocatedCycles === s.completedCycles) { if (s.allocatedCycles >= 2) throw new Error("Cycle limit exceeded"); s.allocatedCycles++; await this.store.save(s); await this.store.event(s.id, { kind: "cycle-reserved", round: s.allocatedCycles }); }
      const round = s.allocatedCycles; const roundName = String(round).padStart(2, "0");
      const completedPath = `rounds/${roundName}/result.json`;
      if (await exists(root, completedPath)) {
        const recovered = await readJSON<RoundResult>(root, completedPath);
        if ((await manifest(join(root, `rounds/${roundName}/project`))).packageHash !== recovered.packageHash) throw new Error("Completed round integrity mismatch");
        s.rounds.push(recovered); s.completedCycles = round; await this.store.save(s);
        if (!recovered.assessment.needsRevision || recovered.assessment.regression) break; continue;
      }
      const previous = s.rounds.at(-1);
      const base = previous ? join(root, `rounds/${String(previous.round).padStart(2, "0")}/project`) : join(root, "original/project");
      const before = await context(base, s.input.documents);
      const contract = await readJSON(root, "context/manuscript-contract.json");
      await this.stage(s, `planning(${round})`, signal);
      const rawPlan = await this.call(s, "reviser", `plan-${round}`, `${PLAN_SCHEMA}\nResponse language: ${s.input.language}\nAuthor constraints: ${JSON.stringify(s.input.authorConstraints)}\nContract: ${JSON.stringify(contract)}\nALL original comments: ${JSON.stringify(s.comments)}\nPrevious round (cumulative): ${JSON.stringify(previous ?? null)}\nBaseline figure findings: ${JSON.stringify(await readJSON(root, "context/figure-review.json"))}\nCurrent complete manuscript: ${contextText(before)}`, parsePlan, signal, [], () => ({ principles: [], argumentMap: "Not assessed", conflicts: ["Revision plan unavailable; manuscript retained."], patches: [], figures: [], decisions: [] }));
      const { plan, checks: planChecks } = reconcilePlan(rawPlan, s.comments, before, round);
      await writeJSON(root, `context/plan-${round}.json`, { schemaVersion: 1, ...plan });
      const candidateRel = `workspace/cycle-${roundName}`; const candidate = await scopedPath(root, candidateRel); const project = join(candidate, "project");
      await this.stage(s, `applying(${round})`, signal);
      if (!await exists(root, `${candidateRel}/candidate.json`)) {
        const applied = applyPatches(before, plan.patches, s.comments, round, { deferUnverified: true });
        const temp = await scopedPath(root, `.state/candidate-${roundName}-${randomUUID()}`); await mkdir(temp, { recursive: true });
        await copyPackage(base, join(temp, "project")); await savePatchedDocuments(join(temp, "project"), applied.documents);
        signal.throwIfAborted();
        if ((await manifest(base)).packageHash !== before.packageHash) throw new Error("원고 버전 충돌: 기준 파일이 변경되었습니다.");
        await writeJSON(temp, "candidate.json", { baseHash: before.packageHash, packageHash: (await manifest(join(temp, "project"))).packageHash, changes: cumulativeChanges(previous?.changes ?? [], applied.changes), authorChecks: mergeAuthorChecks(previous?.authorChecks ?? [], [...applied.authorChecks, ...planChecks], applied.changes) });
        await writeJSON(temp, "revision-plan.json", plan); await rename(temp, candidate);
      }
      let saved = await readJSON<{ baseHash: string; packageHash: string; changes: AppliedChange[]; authorChecks?: AuthorCheck[] }>(candidate, "candidate.json");
      if (saved.baseHash !== before.packageHash || (await manifest(project)).packageHash !== saved.packageHash) throw new Error("작업본 외부 변경을 감지했습니다. 자동 덮어쓰기를 중단했습니다.");
      await this.prepareFigures(s, plan, before, round, signal);
      await this.applyFigures(s, candidate, before, signal);
      saved = await readJSON(candidate, "candidate.json");
      const imported = s.approvals.filter(a => a.round === round && a.status === "imported");
      const figureChecks: AuthorCheck[] = s.approvals.filter(a => a.round === round && a.status !== "imported").map(a => ({
        kind: "figure", id: `F${round}-${a.id}`, target: a.figureId,
        before: before.figures.find(f => f.id === a.figureId)?.source ?? "", proposed: a.specification,
        commentIds: a.commentIds, rationale: a.specification,
        reason: a.failureReason ?? (a.status === "kept" ? "저자가 현재 그림 유지를 선택했습니다. 그림 수정은 적용하지 않았습니다." : "대체 그림 파일이 등록되지 않아 원본을 유지했습니다. 교체 승인은 이미지 생성이나 파일 등록을 실행하지 않습니다."),
      }));
      saved.authorChecks = mergeAuthorChecks((saved.authorChecks ?? []).filter(c => c.kind !== "figure" || !imported.some(a => a.figureId === c.target)), figureChecks, saved.changes);
      await writeJSON(candidate, "candidate.json", saved);
      if (figureChecks.length) await this.store.event(s.id, { kind: "author-check", stage: `figure-followup-${round}`, count: figureChecks.length });
      const revised = await context(project, s.input.documents);
      await this.stage(s, `responding(${round})`, signal);
      const rawResponses = await this.call(s, "reviser", `responses-${round}`, `${RESPONSE_SCHEMA}\nLanguage: ${s.input.language}. Mode: ${s.input.mode}.\nComments: ${JSON.stringify(s.comments)}\nDecisions: ${JSON.stringify(plan.decisions)}\nDeferred edits NOT applied; request author confirmation for each, never claim completed: ${JSON.stringify(saved.authorChecks ?? [])}\nACTUAL cumulative changes: ${JSON.stringify(saved.changes)}\nFigure status: ${JSON.stringify(s.approvals)}\nCurrent manuscript: ${contextText(revised)}`, parseResponses, signal, [], () => []);
      const { responses, checks: responseChecks } = reconcileResponses(rawResponses, s.comments, saved.changes, round);
      saved.authorChecks = mergeAuthorChecks(saved.authorChecks ?? [], [...planChecks, ...responseChecks], saved.changes);
      await writeJSON(candidate, "candidate.json", saved);
      includeAuthorChecks(responses, saved.authorChecks ?? [], saved.changes, s.input.language);
      validateResponses(responses, s.comments, saved.changes);
      await writeJSON(candidate, "response.json", { schemaVersion: 1, responses });
      await this.stage(s, `gpt-assessing(${round})`, signal);
      const figureFindings = await this.visualReview(s, revised, project, `round-${round}`, signal);
      const rawAssessment = await this.call(s, "reviewer", `assessment-${round}`, `${ASSESS_SCHEMA}\nOriginal contract: ${JSON.stringify(contract)}\nOriginal complete manuscript: ${contextText(original)}\nOriginal comments: ${JSON.stringify(s.comments)}\nDeferred edits NOT applied; request author confirmation for each, never claim completed: ${JSON.stringify(saved.authorChecks ?? [])}\nACTUAL cumulative changes: ${JSON.stringify(saved.changes)}\nResponses: ${JSON.stringify(responses)}\nPrior assessment: ${JSON.stringify(previous?.assessment ?? null)}\nCurrent figure findings: ${JSON.stringify(figureFindings)}\nCurrent complete manuscript: ${contextText(revised)}`, parseAssessment, signal, [], () => ({ needsRevision: false, regression: false, summary: "Automated final assessment unavailable. This package is reference material requiring author review.", issues: ["Final assessment was not completed."], comments: [] }));
      const assessment = reconcileAssessment(rawAssessment, s.comments, saved.authorChecks ?? []);
      responses.forEach(r => { r.verification = assessment.comments.find(c => c.commentId === r.commentId)!.verification; });
      if ((await manifest(project)).packageHash !== revised.packageHash) throw new Error("Candidate changed during assessment");
      const result: RoundResult = { authorChecks: saved.authorChecks ?? [], round, packageHash: revised.packageHash, plan, changes: saved.changes, responses, assessment, coverage: revised.coverage,
        validation: ["PASS: source snapshot hash", "PASS: exact patch baseline and protected inline structure", "PASS: numeric changes require reproducible table calculation", "PASS: every original comment has a response or explicit author follow-up", "PASS: changed responses link to applied changes", "PASS: candidate hash stable through assessment"] };
      await writeJSON(candidate, "response.json", { schemaVersion: 1, responses }); await writeJSON(candidate, "gpt-assessment.json", assessment); await writeJSON(candidate, "result.json", result);
      signal.throwIfAborted(); await mkdir(await scopedPath(root, "rounds"), { recursive: true }); await rename(candidate, await scopedPath(root, `rounds/${roundName}`));
      s.rounds.push(result); s.completedCycles = round; await this.store.save(s);
      if (!assessment.needsRevision || assessment.regression) break;
    }
    await this.stage(s, "finalizing", signal); await finalize(root, s); signal.throwIfAborted(); await ensureEditableRevision(root, s); signal.throwIfAborted(); s.status = "completed"; s.stage = "completed"; await this.store.save(s);
  }
  private async applyFigures(s: ReviewSession, candidate: string, before: ReviewContext, signal: AbortSignal) {
    const root = await this.store.root(s.id);
    const receipt = await readJSON<{ baseHash: string; packageHash: string; changes: AppliedChange[]; imported?: string[] }>(candidate, "candidate.json");
    const approvals = s.approvals.filter(a => a.round === s.allocatedCycles && a.status === "imported" && !receipt.imported?.includes(a.id));
    if (!approvals.length) return;
    const temp = await scopedPath(root, `.state/import-${randomUUID()}`); await copyPackage(candidate, temp);
    const project = join(temp, "project"); const c = await context(project, s.input.documents);
    for (const a of approvals) {
      const originalFigure = before.figures.find(f => f.id === a.figureId);
      const f = c.figures.find(f => f.id === a.figureId);
      let bytes: Buffer;
      try {
        if (!f || !originalFigure || originalFigure.hash !== a.inputHash || hash(a.specification) !== a.specificationHash || !a.outputPath || !a.outputHash) throw new Error("Figure approval no longer matches its input and specification");
        bytes = await readFile(await scopedPath(root, a.outputPath));
        if (hash(bytes) !== a.outputHash) throw new Error("Replacement integrity mismatch");
      } catch (error) {
        a.status = "deferred"; a.failureReason = `Replacement not applied; original retained. ${error instanceof Error ? error.message : String(error)}`;
        await this.store.save(s); continue;
      }
      if (!f || !a.outputPath) continue;
      const output = `figures/review-${a.id}${a.outputPath.slice(a.outputPath.lastIndexOf("."))}`;
      await atomicWrite(project, output, bytes); setPath(c.documents[f.document], f.path, output);
      // sourcePath is authoritative for linked figure blocks; clear stale cached remote pixels.
      const props = object(atPath(c.documents[f.document], f.path.slice(0, -1)));
      if (f.path.at(-1) === "sourcePath" && "url" in props) props.url = "";
      receipt.changes.push({ id: `C${a.round}-figure-${a.id}`, target: f.id, before: f.source, after: output, commentIds: a.commentIds, rationale: a.specification });
      receipt.imported = [...(receipt.imported ?? []), a.id];
    }
    await savePatchedDocuments(project, c.documents); receipt.packageHash = (await manifest(project)).packageHash;
    await writeJSON(temp, "candidate.json", receipt); signal.throwIfAborted();
    // Original candidate remains recoverable. A crash between renames reconstructs the same cached plan and imports.
    await rename(candidate, await scopedPath(root, `.state/pre-import-${randomUUID()}`)); await rename(temp, candidate);
  }
  private async prepareFigures(s: ReviewSession, plan: RevisionPlan, c: ReviewContext, round: number, signal: AbortSignal) {
    if (new Set(plan.figures.map(f => f.figureId)).size !== plan.figures.length) throw new Error("Duplicate requests for the same figure");
    for (const proposal of plan.figures) {
      validateCommentIds(proposal.commentIds, s.comments); const f = c.figures.find(f => f.id === proposal.figureId); if (!f) throw new Error("Unknown figure request");
      const specificationHash = hash(proposal.specification); const id = hash(`${s.id}:${round}:${f.id}:${f.hash}:${specificationHash}:import-replacement`);
      if (!s.approvals.some(a => a.id === id)) s.approvals.push({ ...proposal, id, round, inputHash: f.hash, specificationHash, method: "import-replacement", status: "pending" });
    }
    signal.throwIfAborted(); await this.store.save(s);
  }
}
