import { expect, test } from "bun:test";
import { documentReferenceTargets, mergeProjectReferences, type ReferenceDocument } from "./project-references";
const blocks = (label: string) => [{ id: label, type: "figure", props: { label } }];
const saved: ReferenceDocument[] = ["a", "nested/b", "closed"].map((name) => ({
  filename: `${name}.scholarpen.json`, targets: documentReferenceTargets(blocks(`fig-${name.replace("/", "-")}`)),
}));

test("live contents replace saved labels, including unsaved deletions, while closed chapters remain", () => {
  const snapshots = new Map([
    ["/book/documents/a.scholarpen.json", blocks("fig-live")],
    ["/book/documents/nested/b.scholarpen.json", []],
    ["/elsewhere/documents/closed.scholarpen.json", blocks("fig-other-project")],
    ["/book/documents/deleted.scholarpen.json", blocks("fig-deleted-tab")],
  ]);
  const result = mergeProjectReferences(saved, "/book", snapshots, "a.scholarpen.json", blocks("fig-active"));
  expect(result.targets.map((target) => target.label)).toEqual(["fig-active", "fig-closed"]);
  expect(saved[0].targets[0].label).toBe("fig-a");
});

test("live snapshots repair unreadable chapters and normalize legacy targets without mutating content", () => {
  const legacy = [{ type: "heading", content: "State {#sec-state}" }, { type: "figure", props: { figureNumber: 2 } }];
  const result = mergeProjectReferences([
    { filename: "legacy.scholarpen.json", targets: [], error: "bad JSON" },
    { filename: "broken.scholarpen.json", targets: [], error: "bad JSON" },
  ], "/book", new Map([["/book/documents/legacy.scholarpen.json", legacy]]), "active.scholarpen.json", []);
  expect(result.targets.map((target) => target.label)).toEqual(["sec-state", "fig-2"]);
  expect(result.errors).toEqual(["broken.scholarpen.json"]);
  expect(legacy[0].content).toBe("State {#sec-state}");
});
