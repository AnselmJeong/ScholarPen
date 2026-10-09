import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { dominantLanguage, manuscriptLanguage } from "./language";
import { englishHumanizeGuidance } from "./english";
import { ENGLISH_HUMANIZER_COMMIT, ENGLISH_HUMANIZER_RULES } from "./english-rulebook";

test("language routing uses majority words across the document, not character length", () => {
  expect(dominantLanguage("한국어 원고는 짧은 단어가 많아도 한국어 문서다. neuropsychopharmacology interpretation")).toBe("korean");
  expect(dominantLanguage("English prose has the majority of words in this document. 한글 요약")).toBe("english");
  expect(dominantLanguage("한글 English")).toBe("undetermined");
  expect(dominantLanguage("123 !!!")).toBe("undetermined");
  expect(dominantLanguage("これは 日本語 です English")).toBe("undetermined");
  expect(dominantLanguage("한글 원고".normalize("NFD"))).toBe("korean");
});

const schema = new Schema({ nodes: {
  doc: { content: "block+" }, paragraph: { group: "block", content: "inline*" },
  codeBlock: { group: "block", content: "text*", code: true },
  citation: { group: "inline", inline: true, atom: true, attrs: { citekey: {} } },
  text: { group: "inline" },
}, marks: { bold: {}, insertion: {}, deletion: {}, code: {} } });

test("language routing reads accepted prose and excludes code, citation IDs and inserted suggestions", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("이 문서는 한국어 연구 원고로 작성되어 있다. "),
      schema.text("English words ".repeat(100), [schema.marks.insertion.create()]),
      schema.text("More English code ".repeat(100), [schema.marks.code.create()]),
      schema.node("citation", { citekey: "EnglishWords2026" })]),
    schema.node("codeBlock", null, [schema.text("English words ".repeat(100))]),
  ]);
  expect(manuscriptLanguage(doc)).toBe("korean");
});

test("English Humanize embeds pinned upstream rules with academic and protected-format overrides", () => {
  expect(ENGLISH_HUMANIZER_COMMIT).toBe("225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8");
  expect(ENGLISH_HUMANIZER_RULES).toContain("### 26. Re-explaining what the reader knows");
  const guidance = englishHumanizeGuidance();
  expect(guidance).toContain(ENGLISH_HUMANIZER_RULES);
  expect(guidance).toContain("embedded mode");
  expect(guidance).toContain("Keep the author's academic voice");
  expect(guidance).toContain("never strengthen association into causation");
  expect(guidance).toContain("preserve all ScholarPen control markers");
  expect(guidance).toContain("Leave non-English passages unchanged");
  expect(guidance).not.toContain("watermarks-remover");
});
