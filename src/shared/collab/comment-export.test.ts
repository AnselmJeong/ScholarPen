import { expect, test } from "bun:test";
import { exportUnresolvedComments, unresolvedCommentsFilename } from "./comment-export";
import type { ThreadSnapshot } from "./threads";

function thread(id: string, patch: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { id, createdAt: 0, updatedAt: 0, resolved: false, meta: {}, comments: [
    { id: `${id}-1`, userId: "scholarpen-ai", text: "Check this claim.", createdAt: 0, deleted: false },
    { id: `${id}-2`, userId: "me", text: "Use @[exports/references.bib].\nKeep the evidence distinctions.", createdAt: 1000, deleted: false },
  ], ...patch };
}

test("exports every unresolved status in manuscript order with full excerpts and conversations", () => {
  const excerpt = "Long manuscript passage. ".repeat(30);
  const result = exportUnresolvedComments({ documentName: "한글 원고.scholarpen.json", exportedAt: new Date(0), entries: [
    { thread: thread("last", { meta: { status: "in-progress" } }), position: 500, reference: "Last passage" },
    { thread: thread("resolved", { resolved: true }), position: 1 },
    { thread: thread("meta-resolved", { meta: { status: "resolved" } }), position: 2 },
    { thread: thread("first", { meta: { status: "proposed", category: "logic", severity: "high" } }), position: 10, reference: excerpt },
    { thread: thread("whole", { meta: { scope: "document" } }) },
    { thread: thread("orphan") },
    { thread: thread("empty", { comments: [] }) },
  ] });
  expect(result.count).toBe(4);
  expect(result.markdown).toContain(excerpt);
  expect(result.markdown.indexOf("Thread ID: first")).toBeLessThan(result.markdown.indexOf("Thread ID: last"));
  expect(result.markdown).toContain("AI working");
  expect(result.markdown).toContain("Proposed");
  expect(result.markdown).toContain("Whole manuscript.");
  expect(result.markdown).toContain("unanchored comment");
  expect(result.markdown).toContain("ScholarPen AI");
  expect(result.markdown).toContain("**You**");
  expect(result.markdown).toContain("Keep the evidence distinctions.");
  expect(result.markdown).not.toContain("Thread ID: resolved");
  expect(result.markdown).not.toContain("Thread ID: meta-resolved");
});

test("deleted replies are excluded and comment Markdown cannot inject report headings or images", () => {
  const item = thread("t");
  item.comments[0].text = "## Fake heading\n![image](secret.png)\n<script>bad</script>";
  item.comments[1].deleted = true;
  const before = JSON.stringify(item);
  const { markdown } = exportUnresolvedComments({ documentName: "doc.scholarpen.json", entries: [{ thread: item }] });
  expect(markdown).toContain("> \\#\\# Fake heading");
  expect(markdown).toContain("&lt;script&gt;");
  expect(markdown).not.toContain("![image]");
  expect(markdown).not.toContain("Keep the evidence distinctions");
  expect(JSON.stringify(item)).toBe(before);
});

test("export names retain the document name and timestamp, with safe path characters", () => {
  expect(unresolvedCommentsFilename("한글 원고.scholarpen.json", new Date(0)))
    .toBe("한글 원고-unresolved-comments-1970-01-01T00-00-00-000Z.md");
  expect(unresolvedCommentsFilename("folder/doc.scholarpen.json", new Date(1))).not.toContain("/");
});
