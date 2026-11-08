import { expect, test } from "bun:test";
import * as Y from "yjs";
import { supersededDetectionMessages, repeatedPhraseEvidence, formatAIDetectionReport } from "./ai-detection";
import { createThread, addThreadComment, clearAIDetectionResults, readThreads, AI_USER_ID } from "./collab/threads";
import { detectionPresentation } from "./ai-detection-presentation";
import { detectionReportFixture } from "./ai-detection.fixture";

test("clears old document score threads and report replies without deleting other comments", () => {
  const doc = new Y.Doc(); const threads = doc.getMap<any>("threads");
  const old = createThread(threads, "me", "/ai-score", { documentAction: "ai-score", scope: "document" });
  addThreadComment(threads, old, AI_USER_ID, "**DetectorScope · old**");
  const current = createThread(threads, "me", "/ai-score", { documentAction: "ai-score", scope: "document" });
  addThreadComment(threads, current, AI_USER_ID, "**DetectorScope · replace**");
  const ordinary = createThread(threads, "me", "Keep this comment", {});
  addThreadComment(threads, ordinary, AI_USER_ID, "Keep this reply");
  addThreadComment(threads, ordinary, AI_USER_ID, "**DetectorScope · also old**");
  doc.transact(() => clearAIDetectionResults(threads, current));
  const reopened = new Y.Doc(); Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
  const saved = readThreads(reopened.getMap("threads"));
  expect(saved.map(t => t.id).sort()).toEqual([current, ordinary].sort());
  expect(saved.find(t => t.id === current)!.comments.map(c => c.text)).toEqual(["/ai-score"]);
  expect(saved.find(t => t.id === ordinary)!.comments.map(c => c.text)).toEqual(["Keep this comment", "Keep this reply"]);
  doc.destroy(); reopened.destroy();
});

test("live chat hides old scores as soon as a new command starts, including old failures", () => {
  const messages = [
    { id: "1", role: "user", text: "/ai-score" }, { id: "2", role: "assistant", text: "❌ failed" },
    { id: "3", role: "user", text: "normal question" }, { id: "4", role: "assistant", text: "normal answer" },
    { id: "5", role: "user", text: "/ai-score" }, { id: "6", role: "assistant", text: "**DetectorScope · current**" },
  ];
  expect([...supersededDetectionMessages(messages)]).toEqual(["1", "2"]);
});

test("months/to activations alone do not establish a repeated phrase", () => {
  const text = "The third aim is maintenance treatment. The fourth, also over months to years, is functional recovery.";
  const start = text.indexOf("months");
  expect(repeatedPhraseEvidence(text, [{ start, end: start + 6 }, { start: start + 7, end: start + 9 }])).toBeNull();
  const report = structuredClone(detectionReportFixture);
  report.windows[0]!.text = text; report.windows[0]!.end = text.length;
  report.windows[0]!.features[0]!.spans = [{ start, end: start + 6, activation: 2 }, { start: start + 7, end: start + 9, activation: 1 }];
  const output = formatAIDetectionReport(report, "본문");
  expect(output).toContain("반복 구절을 이 구간에서 확인하지 못했습니다");
  expect(detectionPresentation(output)!.sections[0]!.evidence[0]!.excerpts.match(/^>/gm)).toHaveLength(1);
  expect(output).toContain("**months** **to**");
});

test("verified repetitions show both real occurrences and never count citation keys", () => {
  const text = "Recovery over months to years is possible. Observation over months to years continues. [over months to years]";
  const start = text.indexOf("months");
  const evidence = repeatedPhraseEvidence(text, [{ start, end: start + 6 }])!;
  expect(evidence.phrase).toBe("over months to years");
  expect(evidence.spans).toHaveLength(2);
  expect(evidence.spans.map(span => text.slice(span.start, span.end))).toEqual(["over months to years", "over months to years"]);
  expect(repeatedPhraseEvidence("months to years. [months to years]", [{ start: 0, end: 6 }])).toBeNull();
});
