/** Opt-in real subscription smoke test; synthetic manuscript only. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReviewEngine } from "../src/bun/review/orchestrator";
import { SessionStore } from "../src/bun/review/session-store";
import { codexClient } from "../src/bun/codex/client";
import { claudeClient } from "../src/bun/claude/client";
import { DEFAULT_REVIEWERS } from "../src/shared/review-session/types";
if (!process.argv.includes("--live")) throw new Error("Pass --live to invoke both subscription providers on synthetic data.");
const project = resolve(`.review-smoke/${Date.now()}`);
await mkdir(join(project, "documents"), { recursive: true }); await mkdir(join(project, "exports")); await mkdir(join(project, "figures"));
await writeFile(join(project, "figures/illustration.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEkAAAAASUVORK5CYII=", "base64"));
await writeFile(join(project, "documents/synthetic.scholarpen.json"), JSON.stringify([
  { id: "intro", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Synthetic smoke-test manuscript", styles: {} }], children: [] },
  { id: "methods", type: "paragraph", props: {}, content: [{ type: "text", text: "This fictional observational example describes an association between reading and writing clarity. No experiment was conducted; the document is solely for software testing.", styles: {} }], children: [] },
  { id: "conclusion", type: "paragraph", props: {}, content: [{ type: "text", text: "These observations prove that reading causes better writing.", styles: {} }], children: [] },
  { id: "figure", type: "figure", props: { sourcePath: "figures/illustration.png", caption: "A placeholder pixel used solely to test image transmission, not a scientific result." }, content: [], children: [] },
]));
await writeFile(join(project, "exports/references.bib"), "");
const engine = new ReviewEngine(new SessionStore(project), {
  async check() { const c = await codexClient.status(); const a = await claudeClient.status(); if (c.state !== "connected" || a.state !== "connected") throw new Error("Both subscriptions must be connected"); return { codex: c.cliVersion ?? "unknown", anthropic: a.cliVersion ?? "unknown" }; },
  async complete(r) {
    console.log("stage", r.stage, "provider", r.provider, "images", r.images.length);
    const client = r.provider === "codex" ? codexClient : claudeClient; let output = "";
    for await (const chunk of client.stream({ model: r.model, messages: [{ role: "system", content: r.system }, { role: "user", content: r.prompt, images: r.images }], signal: r.signal })) output += chunk;
    return output;
  },
});
try {
  const models = await codexClient.models(); const selected = models.find(m => m.id.includes("luna"))?.id ?? models[0]?.id;
  if (!selected) throw new Error("No GPT model available");
  const s = await engine.create({ projectPath: project, documents: ["synthetic.scholarpen.json"], mode: "peer", maxCycles: 1, reviewerModel: selected, reviserModel: "sonnet", reviewers: [{ ...DEFAULT_REVIEWERS[0], original: "Please replace the causal claim with wording justified by an observational design. Do not modify the placeholder figure: it is solely a transmission test." }], decisionLetter: "", language: "English", authorConstraints: "Preserve the fictional observational design. Do not modify the software-test placeholder figure.", baselineNote: "Synthetic integration test" });
  console.log("session", await engine.store.root(s.id)); await engine.start(s.id); const result = await engine.wait(s.id);
  console.log(JSON.stringify({ status: result.status, stage: result.stage, quality: result.quality, cycles: result.completedCycles, error: result.error, output: await engine.store.root(s.id) }, null, 2));
  if (result.status !== "completed") process.exitCode = 1;
} finally { codexClient.close(); claudeClient.close(); }
