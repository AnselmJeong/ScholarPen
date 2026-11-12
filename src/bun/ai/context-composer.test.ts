import { expect, test } from "bun:test";
import { composeWritingContext, legacyWritingPurpose } from "./context-composer";
import { punctuationGuidance } from "../../shared/writing-preferences";
test("legacy free-form writing requests get a purpose while analysis is never guessed as writing", () => {
  expect(legacyWritingPurpose("이 문장을 다듬어 줘")).toBe("rewrite");
  expect(legacyWritingPurpose("Draft an abstract")).toBe("draft");
  expect(legacyWritingPurpose("Translate into English")).toBe("translate");
  expect(legacyWritingPurpose("이 연구를 설명해 줘")).toBe("chat");
});
test("punctuation-only composition is idempotent and keeps the request snapshot", async () => {
  const source = [{ role: "user" as const, content: "Draft an abstract" }];
  const first = await composeWritingContext(source, undefined, { purpose: "draft", punctuation: { emDash: "allow", semicolon: "avoid" } });
  expect(first[0]?.content).toContain('emDash="allow" semicolon="avoid"');
  expect(await composeWritingContext(first, undefined, { purpose: "draft" })).toBe(first);
  expect(first[1]).toBe(source[0]);
  const captured = [{ role: "system" as const, content: punctuationGuidance({ emDash: "allow", semicolon: "allow" }) }, ...source];
  const result = await composeWritingContext(captured, undefined, { purpose: "draft", punctuation: { emDash: "avoid", semicolon: "avoid" } });
  expect(result.map(m => m.content).join("\n").match(/<scholarpen_punctuation /g)).toHaveLength(1);
  expect(result.map(m => m.content).join("\n")).toContain('emDash="allow" semicolon="allow"');
  expect(await composeWritingContext(result, undefined, { purpose: "draft" })).toBe(result);
});
test("composition is idempotent and leaves protected source messages unchanged", async () => {
  const messages = [{ role: "system" as const, content: '<scholarpen_style profile="fixture">approved</scholarpen_style>' },
    { role: "user" as const, content: "12.5% [@smith2026] $E=mc^2$ ⟦SP:0⟧ 불확실하다" }];
  const result = await composeWritingContext(messages, "/nonexistent", { purpose: "rewrite" });
  expect(result).toBe(messages); expect(result[1]).toEqual(messages[1]);
});
