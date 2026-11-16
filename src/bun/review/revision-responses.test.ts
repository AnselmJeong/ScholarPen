import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateRevisionResponses } from "./revision-responses";
import { responseLetterMarkdown } from "../../shared/review-session/response-letter";

const session = { input: { mode: "peer" }, comments: [
  { id: "R1-C01", reviewerId: "R1", original: "First." },
  { id: "R1-C02", reviewerId: "R1", original: "Second." },
] } as any;
const item = (commentId: string, response: string) => ({ commentId, disposition: "needs-author", response, changeIds: [], locations: [], verification: "not-verified" });
const result = { responses: [item("R1-C01", "Draft one."), item("R1-C02", "Draft two.")] } as any;

test("rewritten responses replace the letter together, keeping a hand-edited letter as a backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "sp-letter-"));
  await writeFile(join(root, "response.json"), JSON.stringify({ schemaVersion: 1, responses: result.responses }));
  await writeFile(join(root, "response-to-reviewers.md"), "# Edited outside ScholarPen\n");
  await Promise.all([
    updateRevisionResponses(root, session, result, items => { items[0].response = "Final one."; }),
    updateRevisionResponses(root, session, result, items => { items[1].response = "Final two."; }),
  ]);
  const saved = JSON.parse(await readFile(join(root, "response.json"), "utf8"));
  // Serialized: neither write loses the other's change.
  expect(saved.responses.map((r: any) => r.response)).toEqual(["Final one.", "Final two."]);
  expect(await readFile(join(root, "response-to-reviewers.md"), "utf8")).toBe(responseLetterMarkdown(session, saved.responses));
  const backups = await readdir(join(root, ".scholarpen", "response-backups"));
  expect(backups).toHaveLength(1);
  expect(await readFile(join(root, ".scholarpen", "response-backups", backups[0]), "utf8")).toBe("# Edited outside ScholarPen\n");
});

test("a failed change leaves the letter as it was", async () => {
  const root = await mkdtemp(join(tmpdir(), "sp-letter-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "response.json"), JSON.stringify({ schemaVersion: 1, responses: result.responses }));
  await expect(updateRevisionResponses(root, session, result, () => { throw new Error("conflict"); })).rejects.toThrow("conflict");
  const saved = JSON.parse(await readFile(join(root, "response.json"), "utf8"));
  expect(saved.responses[0].response).toBe("Draft one.");
});
